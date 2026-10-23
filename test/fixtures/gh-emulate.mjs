#!/usr/bin/env node
// Minimal `gh api` stand-in for tests. Forwards `gh api <path>` to the local
// emulate GitHub server at EMULATE_GITHUB_URL so publish code runs end to end
// without touching api.github.com. Supports --method, --input and a dotted --jq.
import { readFileSync } from "node:fs";

const [subcommand, path, ...rest] = process.argv.slice(2);
if (subcommand !== "api" || !path) {
  process.stderr.write(`gh-emulate: unsupported invocation: ${process.argv.slice(2).join(" ")}\n`);
  process.exit(2);
}
let method = "GET";
let input;
let jq;
for (let index = 0; index < rest.length; index += 1) {
  const flag = rest[index];
  const value = rest[index + 1];
  if (flag === "--method" || flag === "-X") method = value;
  else if (flag === "--input") input = readFileSync(value, "utf8");
  else if (flag === "--jq" || flag === "-q") jq = value;
  else throw new Error(`gh-emulate: unsupported flag ${flag}`);
  index += 1;
}

const headers = {
  authorization: `token ${process.env.EMULATE_GITHUB_TOKEN}`,
  accept: "application/vnd.github+json",
};
const init = { method, headers };
if (input) {
  headers["content-type"] = "application/json";
  init.body = input;
}
const response = await fetch(
  new URL(path.replace(/^\//, ""), `${process.env.EMULATE_GITHUB_URL}/`),
  init,
);
const text = await response.text();
if (!response.ok) {
  process.stderr.write(`gh: ${text} (HTTP ${response.status})\n`);
  process.exit(1);
}
let output = text;
if (jq && jq !== ".") {
  let value = JSON.parse(text);
  for (const key of jq.replace(/^\./, "").split(".")) value = value?.[key];
  output = JSON.stringify(value);
}
process.stdout.write(`${output}\n`);
