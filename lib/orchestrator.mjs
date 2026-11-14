// Orchestrator: recommends an agent, model and effort level for a task.
// It is a local, explainable heuristic. It scores affinity for the kind of work, availability
// (an agent out of tokens is excluded), quota used and open task load. It calls no model.
// Keywords cover English and Spanish so tasks can be written in either language.
import { agents, openStatuses } from './store.mjs';

const normalize = text => String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const affinities = {
  claude: {
    label: 'design, accessibility, writing and review',
    words: ['design', 'diseno', 'css', 'style', 'estilo', 'ui', 'ux', 'interface', 'interfaz', 'visual', 'accessib', 'accesib', 'aria', 'focus', 'foco', 'typograph', 'tipograf', 'spacing', 'espaciado', 'content', 'contenido', 'write', 'redact', 'text', 'texto', 'copy', 'document', 'rule', 'regla', 'review', 'revis', 'validat', 'valid', 'explain', 'explica', 'summar', 'resumen', 'plan', 'decision', 'adr'],
  },
  codex: {
    label: 'code, tests, builds and refactoring',
    words: ['code', 'codigo', 'bug', 'error', 'fail', 'fallo', 'test', 'prueba', 'playwright', 'build', 'lint', 'type', 'tipo', 'typescript', 'refactor', 'script', 'migrat', 'migracion', 'dependenc', 'performance', 'rendimiento', 'budget', 'git', 'rebase', 'commit', 'ci', 'api', 'component', 'componente'],
  },
  gemini: {
    label: 'research, broad reading, translation and images',
    words: ['research', 'investiga', 'search', 'busca', 'source', 'fuente', 'reference', 'referencia', 'compare', 'compara', 'read ', 'lee ', 'leer', 'inventory', 'inventario', 'translat', 'traduc', 'language', 'idioma', 'image', 'imagen', 'illustrat', 'ilustra', 'icon', 'icono', 'catalog', 'glossary', 'glosario', 'taxonom', 'opinion', 'second'],
  },
};

const hardWords = ['architecture', 'arquitectura', 'migrat', 'migracion', 'refactor', 'audit', 'auditoria', 'whole', 'todo el', 'global', 'redesign', 'rediseno', 'security', 'seguridad', 'performance', 'rendimiento', 'several files', 'varios archivos', 'in depth', 'a fondo', 'concurren', 'regression', 'regresion', 'production', 'produccion'];
const easyWords = ['typo', 'errata', 'rename', 'renombra', 'question', 'pregunta', 'quick', 'rapido', 'small', 'pequen', 'link', 'enlace', 'check', 'comprueba', 'see if', 'mira si', 'just ', 'solo ', 'one line', 'una linea', 'lookup', 'consulta'];

// Each keyword is a stem that must start a word; keywords of up to three letters must be the whole word,
// so that "ui" does not match inside "build".
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
  return score <= 0 ? 'low' : score <= 2 ? 'medium' : 'high';
}

function suggestedModel(agent, info, level) {
  if (agent === 'gemini') return level === 'high' ? { model: 'gemini-4-carbon', effort: 'high' } : { model: 'gemini-3.8-flash', effort: 'medium' };
  if (agent === 'claude' && level === 'low') return { model: 'Sonnet 5.5', effort: 'low' };
  return { model: info?.label ?? info?.model ?? 'current model', effort: level };
}

export function recommend(text, agentInfo, tasks = []) {
  const value = normalize(text);
  const level = complexity(text);
  const open = tasks.filter(task => !task.archived && openStatuses.includes(task.status));
  const ranking = agents.map(agent => {
    const info = agentInfo?.[agent] ?? {};
    const reasons = [];
    const hits = affinities[agent].words.filter(word => has(value, word)).length;
    let score = hits * 1.5;
    if (hits) reasons.push(`fits ${affinities[agent].label}`);
    if (info.state === 'out_of_tokens') return { agent, score: -Infinity, excluded: true, reasons: ['out of tokens or quota used up'] };
    if (info.state === 'active') { score += 1; reasons.push('session active'); }
    if (info.state === 'idle') { score -= 0.5; reasons.push('session idle: it needs to be opened'); }
    if (info.state === 'unknown') { score -= 1; reasons.push('state unknown'); }
    if (typeof info.usedPercent === 'number') {
      if (info.usedPercent >= 85) { score -= 2; reasons.push(`quota at ${Math.round(info.usedPercent)} %`); }
      else if (info.usedPercent >= 60) { score -= 0.5; reasons.push(`quota at ${Math.round(info.usedPercent)} %`); }
    }
    const load = open.filter(task => task.assignee === agent).length;
    if (load) { score -= 0.75 * load; reasons.push(`${load} open task${load === 1 ? '' : 's'}`); }
    if (level === 'low' && agent === 'gemini') { score += 0.75; reasons.push('Flash is the fastest and cheapest for simple tasks'); }
    if (level === 'high' && agent !== 'gemini') score += 0.5;
    return { agent, score, reasons, ...suggestedModel(agent, info, level) };
  }).sort((a, b) => b.score - a.score);
  const best = ranking.find(item => !item.excluded);
  if (!best) return { level, agent: null, reasons: ['No agent has tokens available right now.'], ranking };
  return {
    level,
    agent: best.agent,
    model: best.model,
    effort: best.effort,
    reasons: best.reasons.length ? best.reasons : ['no clear signal: the available agent with the least load wins'],
    ranking: ranking.map(({ agent, score, excluded, reasons }) => ({ agent, score: Number.isFinite(score) ? Math.round(score * 100) / 100 : null, excluded: Boolean(excluded), reasons })),
  };
}
