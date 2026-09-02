# ADR-006 · El cutover no re-enrola passkeys

Fecha: 2026-09-02 · Estado: aceptado

## Contexto

Las credenciales actuales se guardan en `users.json` v1 con la clave pública ya convertida a
**JWK** (más `alg`, `signCount`, `aaguid`, `transports`, `backedUp`). Librerías como
SimpleWebAuthn esperan la clave en **COSE**. Cambiar de verificador durante la migración obligaría
a un migrador JWK→COSE probado y a un rollback que entienda ambos formatos.

## Decisión

1. El gateway nuevo lee y escribe el **mismo formato v1**, byte a byte compatible.
2. El verificador WebAuthn se porta a TypeScript conservando algoritmos y checks
   (challenge de un solo uso, `origin`, `rpIdHash`, UP, UV, `signCount`) y el decodificador CBOR
   propio; sin dependencias nuevas.
3. `rpId`, orígenes, `session.key` y la lista de revocación se **copian**, nunca se regeneran.
4. Migrar a SimpleWebAuthn o a un store SQLite es una misión aparte, con dual verifier y su
   propio rollback.

## Consecuencias

- Una passkey enrolada en el stack viejo entra en el nuevo sin tocar el autenticador.
- El coste es mantener un verificador propio; está cubierto por `AUTH-WEBAUTHN-01` con un
  autenticador falso que genera claves y firmas reales (ES256/RS256/Ed25519).
