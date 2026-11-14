// Orquestador: recomienda agente, modelo y nivel de esfuerzo para una tarea.
// Es una heurística local y explicable: puntúa afinidad por tipo de trabajo, disponibilidad
// (sin tokens queda fuera), cuota consumida y carga de tareas abiertas. No llama a ningún modelo.
import { agents } from './store.mjs';

const normalize = text => String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const affinities = {
  claude: {
    label: 'diseño, accesibilidad, redacción y revisión',
    words: ['diseno', 'css', 'estilo', 'ui', 'ux', 'interfaz', 'visual', 'accesib', 'aria', 'foco', 'tipograf', 'espaciado', 'contenido', 'redact', 'texto', 'copy', 'documenta', 'regla', 'revis', 'valid', 'explica', 'resumen', 'plan', 'decision', 'adr'],
  },
  codex: {
    label: 'código, pruebas, build y refactorización',
    words: ['codigo', 'bug', 'error', 'fallo', 'test', 'prueba', 'playwright', 'build', 'lint', 'biome', 'tipo', 'typescript', 'refactor', 'script', 'migracion', 'dependenc', 'rendimiento', 'presupuesto', 'git', 'rebase', 'commit', 'ci', 'api', 'componente', 'astro'],
  },
  gemini: {
    label: 'investigación, lectura amplia, traducción e imágenes',
    words: ['investiga', 'busca', 'fuente', 'referencia', 'compara', 'lee ', 'leer', 'inventario', 'traduc', 'idioma', 'imagen', 'ilustra', 'icono', 'catalogo', 'glosario', 'taxonomia', 'opinion', 'segunda'],
  },
};

const hardWords = ['arquitectura', 'migracion', 'refactor', 'auditoria', 'todo el', 'global', 'rediseno', 'seguridad', 'rendimiento', 'varios archivos', 'a fondo', 'concurren', 'regresion', 'produccion'];
const easyWords = ['errata', 'typo', 'renombra', 'pregunta', 'rapido', 'pequen', 'enlace', 'comprueba', 'mira si', 'solo ', 'una linea', 'consulta'];

// Cada palabra es una raíz que debe empezar palabra; las de hasta tres letras deben ser la palabra entera,
// para que «ui» no coincida dentro de «build».
const matchers = new Map();
const has = (value, word) => {
  if (!matchers.has(word)) {
    const escaped = word.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    matchers.set(word, new RegExp(`\\b${escaped}${word.trim().length <= 3 ? '\\b' : ''}`));
  }
  return matchers.get(word).test(value);
};

export function complexity(text) {
  const value = normalize(text);
  let score = 0;
  const words = value.split(/\s+/).filter(Boolean).length;
  if (words > 60) score += 1;
  if (words > 160) score += 1;
  score += 2 * hardWords.filter(word => has(value, word)).length;
  score -= easyWords.filter(word => has(value, word)).length;
  return score <= 0 ? 'bajo' : score <= 2 ? 'medio' : 'alto';
}

const effortNames = { bajo: 'low', medio: 'medium', alto: 'high' };

function suggestedModel(agent, info, level) {
  if (agent === 'gemini') return level === 'alto' ? { model: 'gemini-4-carbon', effort: 'high' } : { model: 'gemini-3.8-flash', effort: 'medium' };
  if (agent === 'claude' && level === 'bajo') return { model: 'Sonnet 5.5', effort: 'low' };
  return { model: info?.label ?? info?.model ?? 'modelo actual', effort: effortNames[level] };
}

export function recommend(text, agentInfo, tasks = []) {
  const value = normalize(text);
  const level = complexity(text);
  const open = tasks.filter(task => !task.archived && ['asignada', 'en_curso', 'bloqueada'].includes(task.status));
  const ranking = agents.map(agent => {
    const info = agentInfo?.[agent] ?? {};
    const reasons = [];
    const hits = affinities[agent].words.filter(word => has(value, word)).length;
    let score = hits * 1.5;
    if (hits) reasons.push(`encaja con ${affinities[agent].label}`);
    if (info.state === 'sin_tokens') return { agent, score: -Infinity, excluded: true, reasons: ['sin tokens o cuota agotada'] };
    if (info.state === 'activo') { score += 1; reasons.push('sesión activa'); }
    if (info.state === 'inactivo') { score -= 0.5; reasons.push('sesión inactiva: hay que abrirla'); }
    if (info.state === 'desconocido') { score -= 1; reasons.push('estado desconocido'); }
    if (typeof info.usedPercent === 'number') {
      if (info.usedPercent >= 85) { score -= 2; reasons.push(`cuota al ${Math.round(info.usedPercent)} %`); }
      else if (info.usedPercent >= 60) { score -= 0.5; reasons.push(`cuota al ${Math.round(info.usedPercent)} %`); }
    }
    const load = open.filter(task => task.assignee === agent).length;
    if (load) { score -= 0.75 * load; reasons.push(`${load} tarea${load === 1 ? '' : 's'} abierta${load === 1 ? '' : 's'}`); }
    if (level === 'bajo' && agent === 'gemini') { score += 0.75; reasons.push('Flash es el más rápido y barato para tareas sencillas'); }
    if (level === 'alto' && agent !== 'gemini') score += 0.5;
    return { agent, score, reasons, ...suggestedModel(agent, info, level) };
  }).sort((a, b) => b.score - a.score);
  const best = ranking.find(item => !item.excluded);
  if (!best) return { level, agent: null, reasons: ['Ningún agente tiene tokens disponibles ahora.'], ranking };
  return {
    level,
    agent: best.agent,
    model: best.model,
    effort: best.effort,
    reasons: best.reasons.length ? best.reasons : ['sin señales claras: gana el agente disponible con menos carga'],
    ranking: ranking.map(({ agent, score, excluded, reasons }) => ({ agent, score: Number.isFinite(score) ? Math.round(score * 100) / 100 : null, excluded: Boolean(excluded), reasons })),
  };
}
