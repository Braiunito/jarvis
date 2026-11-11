/**
 * El cifrado de Web Push, contra el vector oficial del RFC 8291 (apéndice A).
 *
 * Un navegador que recibe un mensaje mal cifrado no dice nada: lo tira. Así que «se descifra con
 * lo mismo que lo cifró» no prueba nada —un error simétrico pasaría— y lo que se fija aquí son los
 * bytes que el RFC publica, con sus claves y su sal.
 */
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertVapidKeys, encryptPayload, fromB64u, generateVapidKeys, sendPush, vapidAuthorization,
} from '../src/alerts/webpush.js';

const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
};

describe('aes128gcm (RFC 8291)', () => {
  it('produce exactamente la cabecera y el texto cifrado del apéndice A', () => {
    const body = encryptPayload(fromB64u(RFC.plaintext), { p256dh: RFC.uaPublic, auth: RFC.auth }, {
      ephemeralPrivateKey: fromB64u(RFC.asPrivate),
      salt: fromB64u(RFC.salt),
    });

    expect(body.subarray(0, 86).toString('base64url')).toBe(RFC.header);
    expect(body.subarray(86).toString('base64url')).toBe(RFC.ciphertext);
  });

  it('lo que cifra con claves nuevas lo descifra el lado del navegador', () => {
    // Un navegador de mentira: su par, su secreto y el descifrado del RFC hecho a mano.
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const auth = Buffer.alloc(16, 7);
    const message = Buffer.from(JSON.stringify({ title: 'Terminó: deploy', body: 'ñandú ✓' }));

    const body = encryptPayload(message, { p256dh: ua.getPublicKey('base64url'), auth: auth.toString('base64url') });

    const salt = body.subarray(0, 16);
    expect(body.readUInt32BE(16)).toBe(4096);
    const asPublic = body.subarray(21, 21 + body[20]!);
    const secret = ua.computeSecret(asPublic);
    const ikm = Buffer.from(hkdfSync('sha256', secret, auth,
      Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]), 32));
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const sealed = body.subarray(21 + asPublic.length);
    const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);

    expect(plain.at(-1)).toBe(2);
    expect(plain.subarray(0, -1).toString()).toBe(message.toString());
  });
});

describe('VAPID (RFC 8292)', () => {
  it('firma un JWT ES256 que verifica con la clave pública anunciada', () => {
    const keys = generateVapidKeys();
    assertVapidKeys(keys);
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 'mailto:a@b.es', 1_700_000_000);

    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, h, c, s, k] = match as unknown as [string, string, string, string, string];
    expect(k).toBe(keys.publicKey);
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString()) as { aud: string; exp: number; sub: string };
    expect(claims).toEqual({ aud: 'https://fcm.googleapis.com', exp: 1_700_000_000 + 12 * 3600, sub: 'mailto:a@b.es' });

    const pub = fromB64u(keys.publicKey);
    const key = createPublicKey({ format: 'jwk', key: {
      kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url'),
    } });
    expect(verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, fromB64u(s))).toBe(true);
  });

  it('rechaza un par que no se corresponde', () => {
    const a = generateVapidKeys();
    const b = generateVapidKeys();
    expect(() => assertVapidKeys({ publicKey: a.publicKey, privateKey: b.privateKey })).toThrow(/does not match/);
  });
});

describe('sendPush', () => {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const target = { endpoint: 'https://push.example/x', p256dh: ua.getPublicKey('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') };
  const keys = generateVapidKeys();

  it('manda las cabeceras que exige el protocolo', async () => {
    let seen: RequestInit | undefined;
    const result = await sendPush(target, Buffer.from('{}'), {
      keys, subject: 'mailto:a@b.es', urgency: 'high',
      fetchImpl: (async (_url: string, init: RequestInit) => { seen = init; return new Response(null, { status: 201 }); }) as typeof fetch,
    });
    expect(result).toEqual({ ok: true, status: 201, gone: false, error: null });
    const headers = seen?.headers as Record<string, string>;
    expect(headers['content-encoding']).toBe('aes128gcm');
    expect(headers['urgency']).toBe('high');
    expect(headers['ttl']).toBe('86400');
    expect(headers['authorization']).toMatch(/^vapid t=.+, k=/);
  });

  it('un 410 dice que la suscripción ya no existe, y un error de red no lanza', async () => {
    const gone = await sendPush(target, Buffer.from('{}'), {
      keys, subject: 'mailto:a@b.es', fetchImpl: (async () => new Response('bye', { status: 410 })) as typeof fetch,
    });
    expect(gone.gone).toBe(true);
    const down = await sendPush(target, Buffer.from('{}'), {
      keys, subject: 'mailto:a@b.es', fetchImpl: (async () => { throw new Error('ENETUNREACH'); }) as typeof fetch,
    });
    expect(down).toMatchObject({ ok: false, gone: false, error: 'ENETUNREACH' });
  });
});
