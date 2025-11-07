#!/usr/bin/env node

const Database = require('../db/db');

async function migrate() {
  const db = new Database();
  try {
    await db.connect();
    console.log('🚀 Running database migrations...');
    await db.runMigrations();
    console.log('✅ Database migrations complete');
  } catch (error) {
    console.error('❌ Database migration failed:', error.message);
    if (error.migration) {
      console.error(`   Migration: ${error.migration}`);
    }
    console.error('   See logs above for the failing SQL statement.');
    process.exit(1);
  } finally {
    try {
      await db.close();
    } catch (closeError) {
      console.error('⚠️ Failed to close database connection after migration:', closeError.message);
    }
  }
}

migrate();
