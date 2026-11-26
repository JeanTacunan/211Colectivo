import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

test("frontend initializes against HTML IDs and switches account/password controls", async () => {
  const html = await readFile("public/index.html", "utf8");
  const script = await readFile("public/script.js", "utf8");
  const nodes = new Map();
  function element() {
    return { value: "", type: "password", textContent: "", dataset: {}, hidden: false, disabled: false, events: {}, attributes: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(name, handler) { this.events[name] = handler; },
      setAttribute(key, value) { this.attributes[key] = value; },
      showModal() { this.open = true; }, close() { this.open = false; this.events.close?.(); },
      reset() {}, focus() {}, scrollIntoView() {}
    };
  }
  for (const match of html.matchAll(/id="([^"]+)"/g)) nodes.set("#" + match[1], element());
  const menu = element();
  const context = vm.createContext({
    document: { querySelector(selector) { return selector === ".menu-toggle" ? menu : nodes.get(selector) ?? null; }, querySelectorAll() { return []; }, createElement: element },
    IntersectionObserver: class { observe() {} }, Intl, Date, setInterval() {},
    fetch: async path => ({ ok: true, json: async () => path.endsWith("/me") ? { user: null } : { reviews: [], average: 5, total: 0 } })
  });
  vm.runInContext(script, context);
  await new Promise(resolve => setImmediate(resolve));
  nodes.get("#accountButton").events.click();
  assert.equal(nodes.get("#authDialog").open, true);
  nodes.get("#registerTab").events.click();
  assert.equal(nodes.get("#registerFields").disabled, false);
  assert.equal(nodes.get("#authPassword").autocomplete, "new-password");
  nodes.get("#togglePassword").events.click();
  assert.equal(nodes.get("#authPassword").type, "text");
  nodes.get("#togglePassword").events.click();
  assert.equal(nodes.get("#authPassword").type, "password");
  nodes.get("#loginTab").events.click();
  assert.equal(nodes.get("#registerFields").disabled, true);
  nodes.get("#authPassword").value = "temporary password";
  nodes.get("#closeAuth").events.click();
  assert.equal(nodes.get("#authPassword").value, "");
  assert.match(html, /v1\.2\.2/);
});
