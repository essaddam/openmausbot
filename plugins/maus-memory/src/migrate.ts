#!/usr/bin/env node
import { migrate } from "./db.ts";

const url = process.env.MAUS_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("Set MAUS_DATABASE_URL.");
  process.exit(1);
}
const applied = await migrate(url);
console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
