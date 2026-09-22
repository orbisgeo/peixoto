const fs = require('fs');

const samples = JSON.parse(fs.readFileSync('amostras2.geojson', 'utf8'));
const sectors = JSON.parse(fs.readFileSync('setores220926.geojson', 'utf8'));

function rings(geometry) {
  if (geometry.type === 'Polygon') return [geometry.coordinates[0]];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.map(polygon => polygon[0]);
  return [];
}

function inside(point, ring) {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const crosses = ((yi > point[1]) !== (yj > point[1])) &&
      point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi;
    if (crosses) result = !result;
  }
  return result;
}

function zoneName(feature) {
  return String(feature.properties.zona || feature.properties.camada_original || 'Zona Desconhecida');
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function centroid(feature) {
  const ring = rings(feature.geometry)[0] || [];
  return ring.reduce((sum, point) => [sum[0] + point[0], sum[1] + point[1]], [0, 0])
    .map(value => value / ring.length);
}

function distance(first, second) {
  return Math.hypot(first[0] - second[0], first[1] - second[1]);
}

const working = JSON.parse(JSON.stringify(samples));
working.features = working.features.filter(feature => {
  const area = feature.properties.area_total;
  const value = feature.properties.valor;
  return area >= 50 && area <= 5000 && value >= 10 && value <= 5000000;
});

const zoneCentroids = {};
sectors.features.forEach(feature => { zoneCentroids[zoneName(feature)] = centroid(feature); });

working.features.forEach(feature => {
  const properties = feature.properties;
  const type = String(properties.tipo || 'Não Informado').trim().toLowerCase();
  properties.tipo_padrao = type.includes('terreno') || type.includes('vago') || type.includes('vagp') ? 'Lote Vago'
    : type.includes('residencial') || type.includes('residencia') || type.includes('casa') ? 'Residencial'
      : type.includes('comercial') ? 'Comercial' : 'Outros';
  properties.setor = 'Fora de Zona';
  const match = sectors.features.find(sector => rings(sector.geometry).some(ring => inside(feature.geometry.coordinates, ring)));
  if (match) properties.setor = zoneName(match);
});

const zoneValues = {};
working.features.forEach(feature => {
  const properties = feature.properties;
  if (properties.tipo_padrao === 'Lote Vago') {
    const value = properties.valor < 10000 ? properties.valor * 1000 : properties.valor;
    properties.vu_estimado = value / properties.area_total;
    if (!zoneValues[properties.setor]) zoneValues[properties.setor] = [];
    zoneValues[properties.setor].push(properties.vu_estimado);
    properties.status_validacao = 'Base Referência';
  }
});

const limits = {};
Object.entries(zoneValues).forEach(([zone, values]) => {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const deviation = Math.sqrt(values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / values.length);
  limits[zone] = { min: Math.max(0, mean - 1.5 * deviation), max: mean + 1.5 * deviation };
});

working.features.forEach(feature => {
  const properties = feature.properties;
  if (properties.tipo_padrao !== 'Lote Vago') {
    const value = properties.valor < 10000 ? properties.valor * 1000 : properties.valor;
    const constructionCost = (properties.area_contr || 0) * 3229.54 * 0.6;
    const landValue = value - constructionCost;
    properties.custo_construcao = constructionCost;
    properties.valor_residual = landValue;
    if (landValue <= 0) {
      properties.vu_estimado = 0;
      properties.status_validacao = 'Inválida (Custo > Valor)';
    } else {
      properties.vu_estimado = landValue / properties.area_total;
      const limit = limits[properties.setor];
      properties.status_validacao = limit && properties.vu_estimado >= limit.min && properties.vu_estimado <= limit.max
        ? 'Validada por Zona' : 'Inválida (Fora da Tolerância da Zona)';
    }
  }
});

const aggregation = {};
working.features.forEach(feature => {
  const properties = feature.properties;
  const valid = String(properties.status_validacao || '').includes('Validada') || properties.status_validacao === 'Base Referência';
  if (!valid) return;
  if (!aggregation[properties.setor]) aggregation[properties.setor] = { total: 0, vagos: 0, validadas: 0, vus: [], samples: [] };
  const zone = aggregation[properties.setor];
  zone.total++;
  if (properties.status_validacao === 'Base Referência') zone.vagos++;
  if (properties.status_validacao === 'Validada por Zona') zone.validadas++;
  if (properties.vu_estimado) zone.vus.push(properties.vu_estimado);
  if (properties.vu_estimado) zone.samples.push({ id: properties.id, tipo: properties.tipo_padrao || properties.tipo || 'Outros', valor: properties.valor < 10000 ? properties.valor * 1000 : properties.valor, area: properties.area_total, area_contr: properties.area_contr || 0, custo_construcao: properties.custo_construcao || 0, valor_residual: properties.valor_residual ?? (properties.valor < 10000 ? properties.valor * 1000 : properties.valor), vu: properties.vu_estimado, status: properties.status_validacao });
});

sectors.features.forEach(feature => { if (!aggregation[zoneName(feature)]) aggregation[zoneName(feature)] = { total: 0, vagos: 0, validadas: 0, vus: [], samples: [] }; });
const zonesWithData = Object.keys(aggregation).filter(zone => aggregation[zone].vus.length > 0);
const medians = Object.fromEntries(zonesWithData.map(zone => [zone, median(aggregation[zone].vus)]));

Object.keys(aggregation).forEach(zone => {
  const current = aggregation[zone];
  if (current.vus.length || !zoneCentroids[zone]) return;
  const neighbors = zonesWithData.filter(other => zoneCentroids[other]);
  const weighted = neighbors.map(other => {
    const dist = Math.max(distance(zoneCentroids[zone], zoneCentroids[other]), 0.0001);
    return { zone: other, weight: 1 / Math.pow(dist, 2) };
  });
  const weightTotal = weighted.reduce((sum, item) => sum + item.weight, 0);
  if (!weightTotal) return;
  current.vus = [weighted.reduce((sum, item) => sum + medians[item.zone] * item.weight, 0) / weightTotal];
  current.imputado = true;
  current.zonasIdwUsadas = weighted.map(item => item.zone);
});

const output = JSON.parse(JSON.stringify(sectors));
output.name = 'setores_valorados_pgv';
output.features.forEach(feature => {
  const zone = aggregation[zoneName(feature)];
  const properties = feature.properties;
  properties.mediana_vu = median(zone.vus);
  properties.total_validas = zone.total;
  properties.lotes_vagos = zone.vagos;
  properties.edif_validadas = zone.validadas;
  properties.imputado_idw = Boolean(zone.imputado);
  properties.metodo_val = zone.imputado ? 'IDW' : (zone.vus.length ? 'Mediana Direta' : 'Sem Dados');
  properties.amostras_oficiais_ids = zone.samples.map(sample => sample.id);
  properties.amostras_oficiais_detalhes = zone.samples;
  properties.zonas_idw_usadas = zone.zonasIdwUsadas || [];
});
fs.writeFileSync('setores_valorados_pgv.geojson', JSON.stringify(output, null, 2));
console.log(JSON.stringify({ features: output.features.length, workingSamples: working.features.length, officialIds: output.features.reduce((sum, feature) => sum + feature.properties.amostras_oficiais_ids.length, 0), idwZones: output.features.filter(feature => feature.properties.imputado_idw).length }));