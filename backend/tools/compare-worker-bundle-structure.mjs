#!/usr/bin/env node

// Offline structural comparison for a locally supplied Cloudflare Worker
// version response and an RC Wrangler bundle. This tool never connects to the
// network, reads credentials, or prints module/source-map contents.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let ts;
try {
  ts = require('typescript');
} catch {
  fail('TypeScript parser is unavailable in this project installation.');
}

const MAX_INPUT_BYTES = 128 * 1024 * 1024;
const FEATURES = Object.freeze({
  auth: /\b(auth|login|logout|session|cookie|password|authenticate|credential)\b/i,
  group_sync: /shared\s*[/.:_-]?\s*calendar|group.?calendar|group.?sync|syncCalendar|syncPersonal|calendar.?sync/i,
  personal_events: /personal.?event|personal.?calendar|sourceType|syncPersonal|personal_event/i,
  shifts: /\b(shift|wage|payroll|hourly|hours)\b/i,
  push: /\b(push|vapid|subscription|notification)\b/i,
  cron: /\b(scheduled|cron|alarm)\b/i,
  d1: /\b(D1Database|prepare|batch|exec)\b|\b(SELECT|INSERT|UPDATE|DELETE)\b/i,
});

function fail(message) {
  console.error(message);
  process.exit(2);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--self-test') {
      args.selfTest = true;
      continue;
    }
    if (key === '--inspect-rc') {
      args.inspectRc = true;
      continue;
    }
    if (key === '--version-json' || key === '--rc-dir') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) fail('A required input path is missing.');
      args[key === '--version-json' ? 'versionJson' : 'rcDir'] = value;
      i += 1;
      continue;
    }
    fail('Unsupported option.');
  }
  return args;
}

function readUtf8(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    fail('An input file or directory could not be accessed. Check the supplied paths.');
  }
  if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) fail('An input file has an unsupported size or type.');
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    fail('An input file could not be read.');
  }
}

function readJson(filePath) {
  const text = readUtf8(filePath);
  try {
    return JSON.parse(text);
  } catch {
    fail('A supplied JSON input is invalid. No input content was printed.');
  }
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function textFromModule(module) {
  if (typeof module?.content_base64 === 'string') {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(module.content_base64)) {
      fail('A module payload has an unsupported encoding.');
    }
    return Buffer.from(module.content_base64, 'base64').toString('utf8');
  }
  if (typeof module?.content === 'string') {
    if (module.content_encoding === 'base64' || module.encoding === 'base64') {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(module.content)) {
        fail('A module payload has an unsupported encoding.');
      }
      return Buffer.from(module.content, 'base64').toString('utf8');
    }
    return module.content;
  }
  return undefined;
}

function isScriptModule(module) {
  const type = String(module?.content_type ?? '').toLowerCase();
  const name = String(module?.name ?? '').toLowerCase();
  return /javascript|ecmascript|typescript/.test(type) || /\.(m?js|cjs|ts)$/.test(name);
}

function moduleInventory(payload) {
  const root = payload?.result ?? payload;
  if (!root || !Array.isArray(root.modules)) fail('The version JSON does not contain a supported module list.');
  const mainName = typeof root.main_module === 'string' ? root.main_module : 'index.js';
  const allModules = root.modules;
  const scripts = allModules.filter(isScriptModule);
  if (scripts.length === 0) fail('No JavaScript/TypeScript modules were found in the version JSON.');
  const main = scripts.find((item) => item?.name === mainName)
    ?? scripts.find((item) => path.posix.basename(String(item?.name ?? '')) === path.posix.basename(mainName))
    ?? (scripts.length === 1 ? scripts[0] : undefined);
  if (!main) fail('The main script module could not be identified safely.');
  const sourceTexts = [];
  for (const mod of scripts) {
    const content = textFromModule(mod);
    if (typeof content !== 'string') fail('A script module has no supported local content field.');
    sourceTexts.push(content);
  }
  const mainText = textFromModule(main);
  return {
    sourceTexts,
    mainText,
    scriptCount: scripts.length,
    allModuleCount: allModules.length,
    sourceMapPayloads: allModules
      .filter((mod) => /\.map$/i.test(String(mod?.name ?? '')) || /source-map/i.test(String(mod?.content_type ?? '')))
      .map((mod) => textFromModule(mod))
      .filter((value) => typeof value === 'string'),
  };
}

function findRcBundle(directory) {
  let stat;
  try {
    stat = fs.statSync(directory);
  } catch {
    fail('The RC bundle directory could not be accessed.');
  }
  if (!stat.isDirectory()) fail('The RC bundle input must be a directory.');
  const mainPath = path.join(directory, 'index.js');
  const mainText = readUtf8(mainPath);
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const localScripts = entries
    .filter((entry) => entry.isFile() && /\.(m?js|cjs|ts)$/i.test(entry.name) && !/\.map$/i.test(entry.name))
    .map((entry) => readUtf8(path.join(directory, entry.name)));
  if (!localScripts.length) fail('No RC script modules were found.');
  const mapPath = path.join(directory, 'index.js.map');
  let sourceMapText;
  if (fs.existsSync(mapPath)) sourceMapText = readUtf8(mapPath);
  return {
    sourceTexts: localScripts,
    mainText,
    scriptCount: localScripts.length,
    allModuleCount: entries.filter((entry) => entry.isFile()).length,
    sourceMapPayloads: sourceMapText ? [sourceMapText] : [],
  };
}

function isLiteralNode(node) {
  return ts.isStringLiteralLike(node)
    || ts.isNumericLiteral(node)
    || node.kind === ts.SyntaxKind.RegularExpressionLiteral;
}

function canonicalNode(node, keepIdentifierNames, includeLiteralValues = false) {
  const kind = ts.SyntaxKind[node.kind] ?? 'UnknownSyntax';
  if (isLiteralNode(node)) {
    if (!includeLiteralValues) return kind;
    const value = ts.isStringLiteralLike(node) ? node.text : String(node.text ?? '');
    return `${kind}:${JSON.stringify(value)}`;
  }
  if (ts.isIdentifier(node)) return keepIdentifierNames ? `Identifier:${node.text}` : 'Identifier';
  const children = [];
  ts.forEachChild(node, (child) => {
    children.push(canonicalNode(child, keepIdentifierNames, includeLiteralValues));
  });
  return children.length ? `${kind}(${children.join(',')})` : kind;
}

function isFunctionNode(node) {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node);
}

function featureSet(text) {
  return Object.keys(FEATURES).filter((feature) => FEATURES[feature].test(text));
}

function parseAndAnalyze(sourceTexts) {
  const functions = [];
  const topLevelShapes = [];
  const topLevelLiteralHashes = [];
  const topLevelUnits = [];
  const joinedText = sourceTexts.join('\n');
  let parseErrorCount = 0;
  let literalNodeCount = 0;

  for (const [index, text] of sourceTexts.entries()) {
    const file = ts.createSourceFile(`offline-${index}.js`, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (file.parseDiagnostics?.length) parseErrorCount += file.parseDiagnostics.length;
    for (const statement of file.statements) {
      const shape = sha256(canonicalNode(statement, false));
      const lexical = sha256(canonicalNode(statement, true));
      const literalSensitive = sha256(canonicalNode(statement, false, true));
      const statementText = statement.getText(file);
      topLevelShapes.push(shape);
      topLevelLiteralHashes.push(literalSensitive);
      topLevelUnits.push({
        ordinal: topLevelUnits.length + 1,
        shape,
        lexical,
        literalSensitive,
        features: featureSet(statementText),
      });
    }
    const visit = (node) => {
      if (isLiteralNode(node)) literalNodeCount += 1;
      if (isFunctionNode(node)) {
        const functionText = node.getText(file);
        functions.push({
          ordinal: functions.length + 1,
          shape: sha256(canonicalNode(node, false)),
          lexical: sha256(canonicalNode(node, true)),
          literalSensitive: sha256(canonicalNode(node, false, true)),
          features: featureSet(functionText),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }

  return {
    parseErrorCount,
    literalNodeCount,
    functions,
    topLevelShapes,
    topLevelLiteralHashes,
    topLevelUnits,
    features: Object.fromEntries(Object.entries(FEATURES).map(([name, pattern]) => [name, pattern.test(joinedText)])),
  };
}

function multisetDelta(before, after) {
  const oldCounts = new Map();
  const newCounts = new Map();
  for (const item of before) oldCounts.set(item, (oldCounts.get(item) ?? 0) + 1);
  for (const item of after) newCounts.set(item, (newCounts.get(item) ?? 0) + 1);
  let removed = 0;
  let added = 0;
  const keys = new Set([...oldCounts.keys(), ...newCounts.keys()]);
  for (const key of keys) {
    const difference = (newCounts.get(key) ?? 0) - (oldCounts.get(key) ?? 0);
    if (difference > 0) added += difference;
    if (difference < 0) removed += Math.abs(difference);
  }
  return { added, removed };
}

function functionDelta(oldAnalysis, newAnalysis, feature) {
  const select = (analysis) => analysis.functions
    .filter((fn) => feature === 'unclassified' ? fn.features.length === 0 : fn.features.includes(feature));
  const oldFns = select(oldAnalysis);
  const newFns = select(newAnalysis);
  const structural = multisetDelta(oldFns.map((fn) => fn.shape), newFns.map((fn) => fn.shape));
  const identifierSensitive = multisetDelta(oldFns.map((fn) => fn.lexical), newFns.map((fn) => fn.lexical));
  const literalSensitive = multisetDelta(oldFns.map((fn) => fn.literalSensitive), newFns.map((fn) => fn.literalSensitive));
  return {
    before: oldFns.length,
    after: newFns.length,
    structuralAdded: structural.added,
    structuralRemoved: structural.removed,
    identifierSensitiveAdded: identifierSensitive.added,
    identifierSensitiveRemoved: identifierSensitive.removed,
    literalSensitiveAdded: literalSensitive.added,
    literalSensitiveRemoved: literalSensitive.removed,
  };
}

function exactUnitKey(unit) {
  return `${unit.shape}\u0000${unit.lexical}\u0000${unit.literalSensitive}`;
}

function groupedBy(items, keyFor) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFor(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

function orderedCategories(...units) {
  const present = new Set(units.flatMap((unit) => unit?.features ?? []));
  return Object.keys(FEATURES).filter((feature) => present.has(feature));
}

function changeSignals(before, after) {
  if (!before || !after) return ['unpaired-structure'];
  const signals = [];
  if (before.shape !== after.shape) signals.push('syntax-shape');
  if (before.lexical !== after.lexical) signals.push('identifier-sensitive-shape');
  if (before.literalSensitive !== after.literalSensitive) signals.push('literal-sensitive-shape');
  return signals.length ? signals : ['category-membership-only'];
}

function compareUnits(beforeUnits, afterUnits, beforePrefix, afterPrefix) {
  const beforeByExact = groupedBy(beforeUnits, exactUnitKey);
  const afterByExact = groupedBy(afterUnits, exactUnitKey);
  const beforeUsed = new Set();
  const afterUsed = new Set();

  // Exact AST fingerprints are consumed first. Repeated identical functions
  // are interchangeable here, so pair them by occurrence only.
  for (const [key, beforeGroup] of beforeByExact) {
    const afterGroup = afterByExact.get(key) ?? [];
    const count = Math.min(beforeGroup.length, afterGroup.length);
    for (let index = 0; index < count; index += 1) {
      beforeUsed.add(beforeGroup[index]);
      afterUsed.add(afterGroup[index]);
    }
  }

  const beforeRemaining = beforeUnits.filter((unit) => !beforeUsed.has(unit));
  const afterRemaining = afterUnits.filter((unit) => !afterUsed.has(unit));
  const beforeByShape = groupedBy(beforeRemaining, (unit) => unit.shape);
  const afterByShape = groupedBy(afterRemaining, (unit) => unit.shape);
  const drafts = [];
  const pairedBefore = new Set();
  const pairedAfter = new Set();
  const ambiguousShapes = new Set();

  for (const [shape, beforeGroup] of beforeByShape) {
    const afterGroup = afterByShape.get(shape) ?? [];
    if (!afterGroup.length) continue;
    if (beforeGroup.length === 1 && afterGroup.length === 1) {
      const before = beforeGroup[0];
      const after = afterGroup[0];
      pairedBefore.add(before);
      pairedAfter.add(after);
      drafts.push({ before, after, pairing: 'unique-structural-candidate' });
    } else {
      ambiguousShapes.add(shape);
    }
  }

  for (const before of beforeRemaining) {
    if (pairedBefore.has(before)) continue;
    drafts.push({
      before,
      after: null,
      pairing: ambiguousShapes.has(before.shape) ? 'ambiguous-duplicate-structure' : 'unpaired-structure',
    });
  }
  for (const after of afterRemaining) {
    if (pairedAfter.has(after)) continue;
    drafts.push({
      before: null,
      after,
      pairing: ambiguousShapes.has(after.shape) ? 'ambiguous-duplicate-structure' : 'unpaired-structure',
    });
  }

  drafts.sort((left, right) => {
    const leftOrder = Math.min(left.before?.ordinal ?? Number.MAX_SAFE_INTEGER, left.after?.ordinal ?? Number.MAX_SAFE_INTEGER);
    const rightOrder = Math.min(right.before?.ordinal ?? Number.MAX_SAFE_INTEGER, right.after?.ordinal ?? Number.MAX_SAFE_INTEGER);
    return leftOrder - rightOrder;
  });

  let beforeId = 0;
  let afterId = 0;
  const records = drafts.map((draft) => {
    const record = {
      beforeId: draft.before ? `${beforePrefix}${String(++beforeId).padStart(3, '0')}` : null,
      afterId: draft.after ? `${afterPrefix}${String(++afterId).padStart(3, '0')}` : null,
      pairing: draft.pairing,
      categories: orderedCategories(draft.before, draft.after),
      beforeCategories: orderedCategories(draft.before),
      afterCategories: orderedCategories(draft.after),
      changeSignals: changeSignals(draft.before, draft.after),
    };
    return record;
  });

  const categoryMembershipCounts = Object.fromEntries(Object.keys(FEATURES).map((feature) => [
    feature,
    records.filter((record) => record.categories.includes(feature)).length,
  ]));
  return {
    beforeUniqueChangedCount: records.filter((record) => record.beforeId).length,
    afterUniqueChangedCount: records.filter((record) => record.afterId).length,
    uniqueChangeRecordCount: records.length,
    pairedCandidateCount: records.filter((record) => record.pairing === 'unique-structural-candidate').length,
    ambiguousRecordCount: records.filter((record) => record.pairing === 'ambiguous-duplicate-structure').length,
    unpairedRecordCount: records.filter((record) => record.pairing === 'unpaired-structure').length,
    categoryMembershipCounts,
    categoryMembershipCountsAreNonAdditive: true,
    records,
  };
}

function parseSourceMaps(payloads) {
  const sources = [];
  for (const text of payloads) {
    try {
      const map = JSON.parse(text);
      if (!Array.isArray(map.sourcesContent)) continue;
      map.sourcesContent.forEach((content, index) => {
        if (typeof content === 'string') {
          const sourceName = String(map.sources?.[index] ?? '');
          const scriptKind = /\.tsx?$/i.test(sourceName) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
          sources.push({
            text: content,
            shape: sourceShape(content, scriptKind),
            exactHash: sha256(content),
            features: featureSet(content),
          });
        }
      });
    } catch {
      // Malformed or non-source-map module payloads are ignored, never printed.
    }
  }
  return sources;
}

function sourceShape(text, scriptKind) {
  const file = ts.createSourceFile('offline-source', text, ts.ScriptTarget.Latest, true, scriptKind);
  const statementShapes = file.statements.map((statement) => canonicalNode(statement, false));
  return sha256(statementShapes.join('|'));
}

function compareSourceMaps(oldSources, newSources) {
  const exact = multisetDelta(oldSources.map((source) => source.exactHash), newSources.map((source) => source.exactHash));
  const structural = multisetDelta(oldSources.map((source) => source.shape), newSources.map((source) => source.shape));
  const features = {};
  for (const feature of Object.keys(FEATURES)) {
    const oldGroup = oldSources.filter((source) => source.features.includes(feature)).map((source) => source.shape);
    const newGroup = newSources.filter((source) => source.features.includes(feature)).map((source) => source.shape);
    features[feature] = multisetDelta(oldGroup, newGroup);
  }
  return {
    productionSourcesWithContent: oldSources.length,
    rcSourcesWithContent: newSources.length,
    exactContent: exact,
    syntaxStructure: structural,
    byFeature: features,
  };
}

function metadataSummary(payload) {
  const root = payload?.result ?? payload;
  const bindings = Array.isArray(root?.bindings) ? root.bindings : [];
  const cronArray = Array.isArray(root?.triggers?.crons) ? root.triggers.crons : undefined;
  return {
    hasBindingsMetadata: Array.isArray(root?.bindings),
    d1BindingCount: bindings.filter((binding) => String(binding?.type ?? '').toLowerCase() === 'd1').length,
    hasTriggersMetadata: Boolean(root?.triggers),
    cronTriggerCount: cronArray?.length ?? null,
  };
}

function moduleSummary(bundle) {
  return {
    scriptModuleCount: bundle.scriptCount,
    totalModuleOrFileCount: bundle.allModuleCount,
    mainModuleBytes: Buffer.byteLength(bundle.mainText, 'utf8'),
  };
}

function compare(payload, productionBundle, rcBundle) {
  const oldAnalysis = parseAndAnalyze(productionBundle.sourceTexts);
  const newAnalysis = parseAndAnalyze(rcBundle.sourceTexts);
  const featureDiff = {};
  const expectedScopeCandidates = {};
  const needsReview = {};
  for (const feature of Object.keys(FEATURES)) {
    const delta = functionDelta(oldAnalysis, newAnalysis, feature);
    const presenceChanged = oldAnalysis.features[feature] !== newAnalysis.features[feature];
    const hasDelta = delta.structuralAdded > 0 || delta.structuralRemoved > 0
      || delta.identifierSensitiveAdded > 0 || delta.identifierSensitiveRemoved > 0
      || delta.literalSensitiveAdded > 0 || delta.literalSensitiveRemoved > 0 || presenceChanged;
    featureDiff[feature] = {
      presentInProduction: oldAnalysis.features[feature],
      presentInRc: newAnalysis.features[feature],
      presenceChanged,
      ...delta,
    };
    if (hasDelta) {
      const record = {
        structuralAdded: delta.structuralAdded,
        structuralRemoved: delta.structuralRemoved,
        identifierSensitiveAdded: delta.identifierSensitiveAdded,
        identifierSensitiveRemoved: delta.identifierSensitiveRemoved,
        literalSensitiveAdded: delta.literalSensitiveAdded,
        literalSensitiveRemoved: delta.literalSensitiveRemoved,
        presenceChanged,
      };
      if (feature === 'group_sync' || feature === 'personal_events') {
        expectedScopeCandidates[feature] = record;
      } else {
        needsReview[feature] = record;
      }
    }
  }

  const unclassified = functionDelta(oldAnalysis, newAnalysis, 'unclassified');
  const topLevel = multisetDelta(oldAnalysis.topLevelShapes, newAnalysis.topLevelShapes);
  const topLevelLiteral = multisetDelta(oldAnalysis.topLevelLiteralHashes, newAnalysis.topLevelLiteralHashes);
  const functionChanges = compareUnits(oldAnalysis.functions, newAnalysis.functions, 'P', 'R');
  const topLevelChanges = compareUnits(oldAnalysis.topLevelUnits, newAnalysis.topLevelUnits, 'PT', 'RT');
  const oldMaps = parseSourceMaps(productionBundle.sourceMapPayloads);
  const newMaps = parseSourceMaps(rcBundle.sourceMapPayloads);
  const sourceMapComparison = oldMaps.length && newMaps.length
    ? { comparisonAvailable: true, ...compareSourceMaps(oldMaps, newMaps) }
    : {
        comparisonAvailable: false,
        productionSourceMapPayloadCount: productionBundle.sourceMapPayloads.length,
        rcSourceMapPayloadCount: rcBundle.sourceMapPayloads.length,
        productionSourcesWithContent: oldMaps.length,
        rcSourcesWithContent: newMaps.length,
      };

  const oldMeta = metadataSummary(payload);
  const hasUnexpectedStructure = unclassified.structuralAdded > 0 || unclassified.structuralRemoved > 0
    || unclassified.literalSensitiveAdded > 0 || unclassified.literalSensitiveRemoved > 0
    || topLevel.added > 0 || topLevel.removed > 0 || topLevelLiteral.added > 0 || topLevelLiteral.removed > 0;
  return {
    tool: 'offline-worker-bundle-structure',
    networkAccess: false,
    moduleDataPrinted: false,
    production: moduleSummary(productionBundle),
    rc: moduleSummary(rcBundle),
    productionMetadata: oldMeta,
    syntax: {
      parser: 'TypeScript compiler API',
      productionParseErrorCount: oldAnalysis.parseErrorCount,
      rcParseErrorCount: newAnalysis.parseErrorCount,
      productionFunctionCount: oldAnalysis.functions.length,
      rcFunctionCount: newAnalysis.functions.length,
      productionLiteralNodeCount: oldAnalysis.literalNodeCount,
      rcLiteralNodeCount: newAnalysis.literalNodeCount,
      literalValuesPrinted: false,
      literalContentChangesDetectedOnlyAsAggregateCounts: true,
      featureDiff,
      functionChanges,
      topLevelChanges,
      expectedScopeCandidates,
      needsReview,
      unclassified: {
        ...unclassified,
        topLevelStructuralAdded: topLevel.added,
        topLevelStructuralRemoved: topLevel.removed,
        topLevelLiteralSensitiveAdded: topLevelLiteral.added,
        topLevelLiteralSensitiveRemoved: topLevelLiteral.removed,
        hasUnclassifiedChange: hasUnexpectedStructure,
      },
      sourceMapComparison,
    },
    interpretation: [
      'Expected-scope candidates identify only where changes occurred; they are not semantic approval.',
      'Structural fingerprints redact literal values and normalize identifiers; separate aggregate deltas detect literal-content changes without emitting values. Identifier-sensitive deltas can reflect bundling/minification.',
      'Anonymous function IDs are report-local and are not source names. Only unique structural candidates are paired; duplicate shapes and unpaired functions may reflect edits, bundling, splitting, merging, or reordering.',
      'Each changed function appears once in functionChanges.records. Category membership counts overlap and are not additive. Top-level statements can overlap with function-level changes.',
      'No source text, source-map paths, literal values, route strings, binding values, or credentials are included in this report.',
    ],
  };
}

function inspectRc(bundle) {
  const analysis = parseAndAnalyze(bundle.sourceTexts);
  const sourceMapSources = parseSourceMaps(bundle.sourceMapPayloads);
  return {
    tool: 'offline-worker-bundle-structure',
    networkAccess: false,
    moduleDataPrinted: false,
    rc: moduleSummary(bundle),
    syntax: {
      parser: 'TypeScript compiler API',
      parseErrorCount: analysis.parseErrorCount,
      functionCount: analysis.functions.length,
      topLevelStatementCount: analysis.topLevelShapes.length,
      literalNodeCount: analysis.literalNodeCount,
      sourceMapPayloadCount: bundle.sourceMapPayloads.length,
      sourceEntriesWithContent: sourceMapSources.length,
      featureInventory: analysis.features,
      literalValuesPrinted: false,
    },
  };
}

function runSelfTest() {
  let assertions = 0;
  const assert = (condition) => {
    assertions += 1;
    if (!condition) fail(`Offline comparator self-test failed at assertion ${assertions}.`);
  };
  const oldText = 'function sync(x){ return "PRIVATE_TITLE_MARKER" + x; } const key = "PRIVATE_TOKEN_VALUE";';
  const literalChanged = 'function sync(x){ return "PRIVATE_NOTE_MARKER" + x; } const key = "PRIVATE_TOKEN_VALUE";';
  const behaviorChanged = 'function sync(x){ if (x) return x; return "PRIVATE_NOTE_MARKER"; }';
  const oldAnalysis = parseAndAnalyze([oldText]);
  const literalAnalysis = parseAndAnalyze([literalChanged]);
  const behaviorAnalysis = parseAndAnalyze([behaviorChanged]);
  assert(oldAnalysis.parseErrorCount === 0);
  assert(oldAnalysis.functions.length === 1);
  assert(oldAnalysis.functions[0].shape === literalAnalysis.functions[0].shape);
  assert(oldAnalysis.functions[0].lexical === literalAnalysis.functions[0].lexical);
  assert(oldAnalysis.functions[0].literalSensitive !== literalAnalysis.functions[0].literalSensitive);
  assert(oldAnalysis.functions[0].shape !== behaviorAnalysis.functions[0].shape);
  assert(multisetDelta([oldAnalysis.functions[0].shape], [behaviorAnalysis.functions[0].shape]).added === 1);
  const dummyPayload = {
    result: {
      main_module: 'index.js',
      modules: [{
        name: 'index.js',
        content_type: 'application/javascript+module',
        content_base64: Buffer.from(oldText).toString('base64'),
      }],
      bindings: [{ type: 'd1', name: 'PRIVATE_BINDING_NAME', id: 'PRIVATE_DATABASE_ID' }],
      triggers: { crons: ['PRIVATE_CRON_VALUE'] },
    },
  };
  const productionBundle = moduleInventory(dummyPayload);
  const rcBundle = {
    sourceTexts: [literalChanged],
    mainText: literalChanged,
    scriptCount: 1,
    allModuleCount: 1,
    sourceMapPayloads: [],
  };
  const redactedReport = JSON.stringify(compare(dummyPayload, productionBundle, rcBundle));
  assert(!redactedReport.includes('PRIVATE_TITLE_MARKER'));
  assert(!redactedReport.includes('PRIVATE_NOTE_MARKER'));
  assert(!redactedReport.includes('PRIVATE_TOKEN_VALUE'));
  assert(!redactedReport.includes('PRIVATE_BINDING_NAME'));
  assert(!redactedReport.includes('PRIVATE_DATABASE_ID'));
  assert(!redactedReport.includes('PRIVATE_CRON_VALUE'));
  assert(FEATURES.group_sync.test('syncCalendar sourceType personalEvent'));
  assert(FEATURES.d1.test('env.DB.prepare(query)'));
  const mapOne = parseSourceMaps([JSON.stringify({ version: 3, sources: ['safe.ts'], sourcesContent: ['function a(){return "A"}'] })]);
  const mapTwo = parseSourceMaps([JSON.stringify({ version: 3, sources: ['private/path.ts'], sourcesContent: ['function a(){return "B"}'] })]);
  assert(mapOne.length === 1 && mapTwo.length === 1);
  assert(compareSourceMaps(mapOne, mapTwo).syntaxStructure.added === 0);
  const serialized = JSON.stringify(compareSourceMaps(mapOne, mapTwo));
  assert(!serialized.includes('private/path.ts') && !serialized.includes('function a'));

  const productionCode = [
    'function PRIVATE_sharedCalendar_sync(sourceType, shift, DB, push) {',
    '  if (sourceType === "personal") return;',
    '  DB.prepare("INSERT INTO private_table VALUES (?)").bind(shift).run();',
    '  push(shift);',
    '}',
    'function PRIVATE_routeHandler() { return "PRIVATE_ROUTE_LITERAL"; }',
  ].join('\n');
  const rcCode = [
    'function PRIVATE_sharedCalendar_sync(sourceType, shift, DB, push) {',
    '  if (sourceType === "personal") return;',
    '  DB.prepare("INSERT OR REPLACE INTO private_table VALUES (?)").bind(shift).run();',
    '  push(shift);',
    '}',
    'function PRIVATE_routeHandler() { return "PRIVATE_ROUTE_LITERAL_CHANGED"; }',
  ].join('\n');
  const privatePayload = {
    result: {
      bindings: [
        { type: 'd1', name: 'PRIVATE_BINDING_NAME', id: 'PRIVATE_DATABASE_ID' },
        { type: 'secret_text', name: 'PRIVATE_SECRET_NAME', text: 'PRIVATE_SECRET_VALUE' },
      ],
      triggers: { crons: ['PRIVATE_CRON_VALUE'] },
    },
  };
  const safeReport = compare(
    privatePayload,
    {
      sourceTexts: [productionCode],
      mainText: productionCode,
      scriptCount: 1,
      allModuleCount: 1,
      sourceMapPayloads: [JSON.stringify({
        version: 3,
        sources: ['PRIVATE_SOURCE_MAP_PATH'],
        sourcesContent: ['function PRIVATE_mapFunction() { return "PRIVATE_MAP_LITERAL"; }'],
      })],
    },
    {
      sourceTexts: [rcCode],
      mainText: rcCode,
      scriptCount: 1,
      allModuleCount: 1,
      sourceMapPayloads: [JSON.stringify({
        version: 3,
        sources: ['PRIVATE_RC_SOURCE_MAP_PATH'],
        sourcesContent: ['function PRIVATE_mapFunction() { return "PRIVATE_MAP_LITERAL_CHANGED"; }'],
      })],
    },
  );
  const safeReportText = JSON.stringify(safeReport);
  const functionChanges = safeReport.syntax.functionChanges;
  assert(functionChanges.uniqueChangeRecordCount === 2);
  assert(functionChanges.beforeUniqueChangedCount === 2 && functionChanges.afterUniqueChangedCount === 2);
  assert(functionChanges.pairedCandidateCount === 2);
  assert(functionChanges.categoryMembershipCountsAreNonAdditive === true);
  const overlappingRecord = functionChanges.records.find((record) => record.categories.includes('group_sync'));
  assert(Boolean(overlappingRecord));
  assert(overlappingRecord.categories.includes('personal_events'));
  assert(overlappingRecord.categories.includes('shifts'));
  assert(overlappingRecord.categories.includes('push'));
  assert(overlappingRecord.categories.includes('d1'));
  const functionIds = functionChanges.records.flatMap((record) => [record.beforeId, record.afterId]).filter(Boolean);
  assert(functionIds.every((id) => /^(P|R)\d{3}$/.test(id)));
  assert(new Set(functionIds).size === functionIds.length);
  assert(safeReport.syntax.topLevelChanges.uniqueChangeRecordCount === 2);
  assert(safeReport.syntax.topLevelChanges.records.every((record) =>
    [record.beforeId, record.afterId].filter(Boolean).every((id) => /^(PT|RT)\d{3}$/.test(id))));
  const ambiguousBefore = parseAndAnalyze([
    'function PRIVATE_duplicateOne(value) { return value + "PRIVATE_A"; }',
    'function PRIVATE_duplicateTwo(value) { return value + "PRIVATE_B"; }',
  ]);
  const ambiguousAfter = parseAndAnalyze([
    'function PRIVATE_duplicateThree(value) { return value + "PRIVATE_C"; }',
    'function PRIVATE_duplicateFour(value) { return value + "PRIVATE_D"; }',
  ]);
  const ambiguousReport = compareUnits(ambiguousBefore.functions, ambiguousAfter.functions, 'P', 'R');
  assert(ambiguousReport.pairedCandidateCount === 0);
  assert(ambiguousReport.ambiguousRecordCount === 4);
  assert(ambiguousReport.records.every((record) => record.pairing === 'ambiguous-duplicate-structure'));
  for (const marker of [
    'PRIVATE_sharedCalendar_sync', 'PRIVATE_routeHandler', 'PRIVATE_ROUTE_LITERAL',
    'PRIVATE_ROUTE_LITERAL_CHANGED', 'PRIVATE_BINDING_NAME', 'PRIVATE_DATABASE_ID',
    'PRIVATE_SECRET_NAME', 'PRIVATE_SECRET_VALUE', 'PRIVATE_CRON_VALUE',
    'PRIVATE_SOURCE_MAP_PATH', 'PRIVATE_RC_SOURCE_MAP_PATH', 'PRIVATE_MAP_LITERAL',
    'PRIVATE_MAP_LITERAL_CHANGED', 'INSERT OR REPLACE',
    'PRIVATE_duplicateOne', 'PRIVATE_duplicateTwo', 'PRIVATE_duplicateThree', 'PRIVATE_duplicateFour',
    'PRIVATE_A', 'PRIVATE_B', 'PRIVATE_C', 'PRIVATE_D',
  ]) assert(!safeReportText.includes(marker));
  assert(!/[a-f0-9]{64}/i.test(safeReportText));
  console.log(`SELF-TESTS PASSED: ${assertions} assertions; no fixture content emitted.`);
}

const args = parseArgs(process.argv.slice(2));
if (args.selfTest) {
  runSelfTest();
} else if (args.inspectRc) {
  if (!args.rcDir || args.versionJson) fail('Use --inspect-rc with --rc-dir only.');
  console.log(JSON.stringify(inspectRc(findRcBundle(args.rcDir)), null, 2));
} else {
  if (!args.versionJson || !args.rcDir) {
    fail('Usage: node compare-worker-bundle-structure.mjs --version-json <private-response.json> --rc-dir <dry-run-bundle-directory>');
  }
  const payload = readJson(args.versionJson);
  const productionBundle = moduleInventory(payload);
  const rcBundle = findRcBundle(args.rcDir);
  const report = compare(payload, productionBundle, rcBundle);
  console.log(JSON.stringify(report, null, 2));
}
