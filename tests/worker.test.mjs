import test from "node:test";
import assert from "node:assert/strict";
import { resolveAverage, validatePhone, validName, validatePassword, validateReview } from "../src/worker.js";

test("promedio global arranca en 5 cuando no hay reseñas", () => {
  assert.equal(resolveAverage(0, 0), 5);
  assert.equal(resolveAverage(4.5, 3), 4.5);
});

test("valida celular, nombres y contraseña", () => {
  assert.equal(validatePhone("900000001"), true);
  for (const value of ["800000001", "90000000", "9000000001", 900000001, "+51900000001", "900 00001"]) assert.equal(validatePhone(value), false);
  assert.equal(validatePassword("una-clave-larga"), null);
  assert.match(validatePassword("corta"), /8 caracteres/);
  assert.match(validatePassword("x".repeat(129)), /larga/);
  assert.equal(validName("  "), false);
  assert.equal(validName("Ana María"), true);
});

test("valida reseña, estrellas y límite", () => {
  assert.equal(validateReview(5, "Excelente servicio"), null);
  assert.match(validateReview(0, "Comentario"), /1 a 5/);
  assert.match(validateReview(4.5, "Comentario"), /1 a 5/);
  assert.match(validateReview(5, ""), /comentario/);
  assert.match(validateReview(5, "x".repeat(281)), /280/);
});
