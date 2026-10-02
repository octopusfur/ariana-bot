'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { detectNaijaLanguage: d, naijaInstruction } = require('../naija_lang');

test('detects Pidgin in a single clear message', () => {
  assert.strictEqual(d('wetin dey happen oga, abeg talk true'), 'pcm');
  assert.strictEqual(d('how far, you don chop?'), 'pcm');
  assert.strictEqual(d('I wan come see you tomorrow'), 'pcm');
  assert.strictEqual(d('Abeg no vex, na so e be o'), 'pcm');
});

test('plain English, Spanish, and look-alike words never flip to Pidgin', () => {
  assert.strictEqual(d('hey how are you doing today'), null);
  assert.strictEqual(d('make sure you fit everything in the car'), null);
  assert.strictEqual(d('hola mi amor, una pregunta'), null);
  assert.strictEqual(d('I love Nigerian jollof'), null);
  assert.strictEqual(d('lol ok'), null);
});

test('a short reply inside a Pidgin chat stays Pidgin', () => {
  assert.strictEqual(d('ok na', ['wetin dey happen', 'abeg wahala dey', 'oya come']), 'pcm');
  assert.strictEqual(d('lol ok', ['wetin dey happen', 'abeg wahala dey', 'oya come']), 'pcm'); // established Pidgin chat: don't flip on a short message
  assert.strictEqual(d('lol ok', ['hello', 'how are you']), null);
});

test('detects Yoruba, with or without tone marks', () => {
  assert.strictEqual(d('bawo ni, e kaaro omo mi'), 'yo');
  assert.strictEqual(d('mo dupe pupo, o dabo'), 'yo');
  assert.strictEqual(d('Ẹ kú ọjọ́ mẹ́ta, báwo ni?'), 'yo');
});

test('instructions exist for pcm and yo only', () => {
  assert.match(naijaInstruction('pcm'), /PIDGIN/);
  assert.match(naijaInstruction('yo'), /YORUBA/);
  assert.strictEqual(naijaInstruction(null), '');
});
