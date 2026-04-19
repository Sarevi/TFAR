#!/usr/bin/env node
/**
 * Purga el X% más antiguo de preguntas cacheadas por dificultad.
 *
 * - Elaboradas: 50% más antiguas
 * - Simple:     30% más antiguas
 * - Media:      30% más antiguas
 *
 * Uso:
 *   node scripts/purge-old-cache.js              → dry-run (solo muestra qué haría)
 *   node scripts/purge-old-cache.js --confirm    → ejecuta el borrado (hace backup antes)
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'oposiciones.db');
const CONFIRM = process.argv.includes('--confirm');

const PURGE_RATIOS = {
  elaborada: 0.50,
  simple: 0.30,
  media: 0.30
};

function log(msg) { console.log(msg); }

function fmt(n) { return n.toLocaleString('es-ES'); }

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`❌ No se encuentra la base de datos en ${DB_PATH}`);
    process.exit(1);
  }

  log('='.repeat(60));
  log('🧹 PURGA DE CACHÉ DE PREGUNTAS ANTIGUAS');
  log('='.repeat(60));
  log(`📂 Base de datos: ${DB_PATH}`);
  log(`🔒 Modo: ${CONFIRM ? 'EJECUCIÓN REAL' : 'DRY-RUN (simulación)'}`);
  log('');

  const db = new Database(DB_PATH);

  // 1. Conteos actuales
  log('📊 ESTADO ACTUAL:');
  const totalRow = db.prepare('SELECT COUNT(*) AS c FROM question_cache').get();
  log(`   Total preguntas cacheadas: ${fmt(totalRow.c)}`);

  const counts = db.prepare(
    'SELECT difficulty, COUNT(*) AS c FROM question_cache GROUP BY difficulty'
  ).all();
  for (const r of counts) {
    log(`   - ${r.difficulty.padEnd(10)}: ${fmt(r.c)}`);
  }
  log('');

  // 2. Calcular cuántas se borrarían
  log('🎯 PLAN DE PURGA:');
  const plan = {};
  for (const [difficulty, ratio] of Object.entries(PURGE_RATIOS)) {
    const row = db.prepare(
      'SELECT COUNT(*) AS c FROM question_cache WHERE difficulty = ?'
    ).get(difficulty);
    const toDelete = Math.floor(row.c * ratio);
    plan[difficulty] = { total: row.c, toDelete, ratio };
    log(
      `   - ${difficulty.padEnd(10)}: borrar ${fmt(toDelete)} / ${fmt(row.c)} ` +
      `(${(ratio * 100).toFixed(0)}% más antiguas)`
    );
  }
  const totalToDelete = Object.values(plan).reduce((s, p) => s + p.toDelete, 0);
  log(`   ──────────────────────────────`);
  log(`   TOTAL A BORRAR: ${fmt(totalToDelete)}`);
  log('');

  if (!CONFIRM) {
    log('ℹ️  Esto es solo una simulación. Para ejecutar de verdad:');
    log('   node scripts/purge-old-cache.js --confirm');
    db.close();
    return;
  }

  // 3. Backup
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(
    path.dirname(DB_PATH),
    `oposiciones.backup-${timestamp}.db`
  );
  log(`💾 Creando backup: ${backupPath}`);
  fs.copyFileSync(DB_PATH, backupPath);
  const backupSize = (fs.statSync(backupPath).size / (1024 * 1024)).toFixed(2);
  log(`   ✅ Backup creado (${backupSize} MB)`);
  log('');

  // 4. Ejecutar borrado
  log('🗑️  EJECUTANDO BORRADO:');
  const deleteStmt = db.prepare(`
    DELETE FROM question_cache
    WHERE id IN (
      SELECT id FROM question_cache
      WHERE difficulty = ?
      ORDER BY generated_at ASC
      LIMIT ?
    )
  `);

  const totals = { deleted: 0 };
  const runAll = db.transaction(() => {
    for (const [difficulty, info] of Object.entries(plan)) {
      if (info.toDelete <= 0) continue;
      const res = deleteStmt.run(difficulty, info.toDelete);
      log(`   - ${difficulty.padEnd(10)}: ${fmt(res.changes)} borradas`);
      totals.deleted += res.changes;
    }
  });
  runAll();
  log(`   ──────────────────────────────`);
  log(`   TOTAL BORRADAS: ${fmt(totals.deleted)}`);
  log('');

  // 5. Optimizar base de datos
  log('⚙️  Optimizando base de datos (VACUUM)...');
  db.exec('VACUUM');
  log('   ✅ VACUUM completado');
  log('');

  // 6. Estado final
  log('📊 ESTADO FINAL:');
  const finalTotal = db.prepare('SELECT COUNT(*) AS c FROM question_cache').get();
  log(`   Total preguntas restantes: ${fmt(finalTotal.c)}`);
  const finalCounts = db.prepare(
    'SELECT difficulty, COUNT(*) AS c FROM question_cache GROUP BY difficulty'
  ).all();
  for (const r of finalCounts) {
    log(`   - ${r.difficulty.padEnd(10)}: ${fmt(r.c)}`);
  }
  log('');

  db.close();

  log('='.repeat(60));
  log('✅ PURGA COMPLETADA');
  log(`   Backup disponible en: ${backupPath}`);
  log('   Para revertir: copiar backup sobre oposiciones.db con el server parado');
  log('='.repeat(60));
}

main().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
