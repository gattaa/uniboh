import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCareer, parseServices } from "./sol.js";

// Synthetic fixtures mirroring the observed Studenti Online (SOL) home layout.
// NO real student data — names/codes/emails below are invented. The SOL parsers
// were reverse-engineered from a single logged-in capture, so these fixtures
// double as the contract the selectors are expected to satisfy.

const homePage = (opts?: { programme?: boolean; requests?: string }) => `
<html><body>
  <div class="corpo">
    <h1 class="titoloPagina">Benvenuto Mario Rossi</h1>
    <div class="identity">
      <div class="nome-cell">
        <p>Mario Rossi</p>
        <p class="cell">0000123456</p>
      </div>
      <div class="email"><a href="mailto:mario.rossi@studio.unibo.it">mario.rossi@studio.unibo.it</a></div>
    </div>
    <div class="quickInfo">
      ${
        opts?.programme === false
          ? ""
          : `<div class="box"><h3>Corso di studio</h3><a href="/sol/cds/6734.htm">Medicine and Surgery (6734)</a></div>`
      }
    </div>
    <div class="elementiAttivi">
      <ul class="tab"><li class="selected">Richieste in corso</li></ul>
      ${opts?.requests ?? "Non hai richieste in corso"}
      <a href="/sol/studenti/storicoRichieste.htm">Vedi tutte »</a>
    </div>
    <div class="contenutiCol">
      <div class="box"><ul>
        <li>
          <h4><a href="/sol/studenti/situazioneTasse.htm">Situazione tasse - Iscrizione</a></h4>
          <p><a href="/sol/studenti/situazioneTasse.htm">Visualizza / paga le tue tasse</a></p>
        </li>
        <li>
          <h4><a href="/sol/studenti/certificati.htm">Certificati</a></h4>
          <p><a href="/sol/studenti/certificati.htm">Scarica i certificati</a></p>
        </li>
      </ul></div>
    </div>
  </div>
</body></html>`;

test("parseCareer extracts greeting, identity, programme and active requests", () => {
  const career = parseCareer(homePage(), "https://studenti.unibo.it/sol/studenti/homeStudentiOnline.htm");
  assert.equal(career.greeting, "Benvenuto Mario Rossi");
  assert.equal(career.student.name, "Mario Rossi");
  assert.equal(career.student.matricola, "0000123456");
  assert.equal(career.student.email, "mario.rossi@studio.unibo.it");
  assert.deepEqual(career.programme, {
    name: "Medicine and Surgery",
    code: "6734",
    url: "https://studenti.unibo.it/sol/cds/6734.htm"
  });
  assert.equal(career.activeRequests?.tab, "Richieste in corso");
  assert.equal(career.activeRequests?.hasRequests, false);
  assert.match(career.activeRequests?.summary ?? "", /Non hai richieste/);
});

test("parseCareer flags in-progress requests when the panel is not the empty notice", () => {
  const career = parseCareer(homePage({ requests: "Hai 2 richieste in corso" }));
  assert.equal(career.activeRequests?.hasRequests, true);
});

test("parseCareer tolerates a missing Corso di studio box", () => {
  const career = parseCareer(homePage({ programme: false }));
  assert.equal(career.programme, null);
});

test("parseCareer throws on an unrecognisable (non-SOL) page", () => {
  assert.throws(
    () => parseCareer("<html><body><p>something else entirely</p></body></html>"),
    /recognise the SOL home layout/i
  );
});

test("parseServices lists the service tiles with resolved links", () => {
  const { services } = parseServices(homePage(), "https://studenti.unibo.it/sol/studenti/homeStudentiOnline.htm");
  assert.equal(services.length, 2);
  assert.deepEqual(services[0], {
    name: "Situazione tasse - Iscrizione",
    url: "https://studenti.unibo.it/sol/studenti/situazioneTasse.htm",
    description: "Visualizza / paga le tue tasse"
  });
});

test("SOL readers throw on an expired/SSO session (redirect to IdP)", () => {
  const samlForm = `<html><body><form><input type="hidden" name="SAMLRequest" value="..."/></form></body></html>`;
  assert.throws(() => parseCareer(samlForm), /expired|SSO|scaduta|welcome/i);
  assert.throws(() => parseServices(samlForm), /expired|SSO|scaduta|welcome/i);
});

test("SOL readers throw when bounced to the public welcome page", () => {
  assert.throws(
    () => parseCareer("<html><body>public landing</body></html>", "https://studenti.unibo.it/sol/welcome.htm"),
    /expired|SSO|scaduta|welcome/i
  );
});
