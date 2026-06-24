#!/usr/bin/env node
// =============================================================================
// Hover Translator — Premium Key Generator
// =============================================================================
// Uso: node keygen.js [cantidad]
// Ejemplo: node keygen.js 10
//
// ⚠️  IMPORTANTE: Cambia HMAC_SECRET por el mismo valor que usas en background.js
// =============================================================================

const crypto = require('crypto');

// ⚠️  DEBE coincidir exactamente con el valor en background.js
const HMAC_SECRET = '4b3513210b5222f854582282135d18e17aa7fd6d4f997801414a4565069ef503';

function generateKey() {
  // 8 caracteres aleatorios en base36 (letras + números), en mayúsculas
  const data = crypto.randomBytes(6).toString('hex').substring(0, 8).toUpperCase();

  // HMAC-SHA256 del data con el secreto
  const hmac = crypto
    .createHmac('sha256', HMAC_SECRET)
    .update(data)
    .digest('hex')
    .substring(0, 8)
    .toUpperCase();

  return `HVTR-${data}-${hmac}`;
}

// Genera N claves (por defecto 1)
const count = parseInt(process.argv[2]) || 1;

console.log(`\nGenerando ${count} clave(s) premium...\n`);

for (let i = 0; i < count; i++) {
  console.log(generateKey());
}

console.log(`\nListo. Envía cada clave a un cliente diferente.`);
console.log(`⚠️  Cada clave puede usarse una sola vez por instalación (se guarda localmente).\n`);
