import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDniPerson, validateDni, validateEmail, validatePassword, validateReview } from "../src/worker.js";

test("DNI exige exactamente ocho números", () => {
  assert.equal(validateDni("12345678"), true);
  for (const value of ["1234567", "123456789", "1234ABCD", " 12345678", "1234-678", 12345678]) assert.equal(validateDni(value), false);
});

test("normaliza solo nombres y apellidos", () => {
  assert.deepEqual(normalizeDniPerson({ nombres: "JEAN PAUL", apellido_paterno: "TACUNAN", apellido_materno: "TEST" }), {
    nombres: "JEAN PAUL", apellidoPaterno: "TACUNAN", apellidoMaterno: "TEST", nombreCompleto: "JEAN PAUL TACUNAN TEST"
  });
});

test("normaliza variantes del payload del proveedor", () => {
  assert.deepEqual(normalizeDniPerson({ data: { nombre: "JEAN PAUL", apellido: "TACUNAN", maternalSurname: "TEST" } }), {
    nombres: "JEAN PAUL", apellidoPaterno: "TACUNAN", apellidoMaterno: "TEST", nombreCompleto: "JEAN PAUL TACUNAN TEST"
  });
  assert.deepEqual(normalizeDniPerson({ person: { names: "JEAN", surname: "TACUNAN", secondSurname: "TEST" } }), {
    nombres: "JEAN", apellidoPaterno: "TACUNAN", apellidoMaterno: "TEST", nombreCompleto: "JEAN TACUNAN TEST"
  });
});

test("valida correo y contraseña", () => {
  assert.equal(validateEmail("persona@correo.pe"), true);
  assert.equal(validateEmail("correo-invalido"), false);
  assert.equal(validatePassword("12345678", "12345678"), null);
  assert.match(validatePassword("1234567", "1234567"), /8 caracteres/);
  assert.match(validatePassword("12345678", "87654321"), /no coinciden/);
});

test("valida reseña, estrellas y límite", () => {
  assert.equal(validateReview(5, "Excelente servicio"), null);
  assert.match(validateReview(0, "Comentario"), /1 a 5/);
  assert.match(validateReview(4.5, "Comentario"), /1 a 5/);
  assert.match(validateReview(5, ""), /comentario/);
  assert.match(validateReview(5, "x".repeat(281)), /280/);
});
