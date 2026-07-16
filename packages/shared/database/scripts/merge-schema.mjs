#!/usr/bin/env node
/**
 * merge-schema.mjs
 * Stitches the module-owned Prisma partials into one generated schema:
 *
 *   shared/database/prisma/00-base.prisma      (generator + datasource)
 *   shared/database/prisma/10-enums.prisma     (shared enums)
 *   packages/<module>/prisma/*.prisma          (module models, sorted)
 *        │
 *        ▼
 *   shared/database/prisma/schema.prisma       (GENERATED — never hand-edit)
 *
 * Deterministic order: shared partials by filename, then packages
 * alphabetically, then files within each package alphabetically.
 * Run via: pnpm db:merge   (or automatically as part of db:generate/db:migrate)
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../.."); // packages/shared/database/scripts -> repo root
const sharedPrismaDir = path.resolve(repoRoot, "packages/shared/database/prisma");
const packagesDir = path.resolve(repoRoot, "packages");
const outputPath = path.join(sharedPrismaDir, "schema.prisma");

const isPartial = (name) => name.endsWith(".prisma") && name !== "schema.prisma";

const collectSharedPartials = async () => {
    const entries = await readdir(sharedPrismaDir);
    return entries
        .filter(isPartial)
        .sort()
        .map((name) => path.join(sharedPrismaDir, name));
};

const collectModulePartials = async () => {
    if (!existsSync(packagesDir)) return [];
    const packages = (await readdir(packagesDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();

    const files = [];
    for (const pkg of packages) {
        const prismaDir = path.join(packagesDir, pkg, "prisma");
        if (!existsSync(prismaDir)) continue;
        const entries = (await readdir(prismaDir)).filter(isPartial).sort();
        for (const name of entries) files.push(path.join(prismaDir, name));
    }
    return files;
};

/** Guard against two modules declaring the same model/enum name. */
const assertNoDuplicateDeclarations = (merged) => {
    const seen = new Map();
    const pattern = /^(model|enum)\s+(\w+)\s+\{/gm;
    let match;
    while ((match = pattern.exec(merged)) !== null) {
        const key = `${match[1]} ${match[2]}`;
        if (seen.has(key)) {
            throw new Error(
                `Duplicate declaration "${key}" — declared in more than one partial. ` +
                `Each model/enum must be owned by exactly one module.`,
            );
        }
        seen.set(key, true);
    }
};

const main = async () => {
    const partials = [
        ...(await collectSharedPartials()),
        ...(await collectModulePartials()),
    ];
    if (partials.length === 0) throw new Error("No .prisma partials found.");

    const chunks = [
        "// ============================================================================",
        "// GENERATED FILE — DO NOT EDIT.",
        "// Produced by shared/database/scripts/merge-schema.mjs from the partials",
        "// listed below. Edit the module-owned partial instead, then re-run db:merge.",
        "// ============================================================================",
        "",
    ];

    for (const file of partials) {
        const rel = path.relative(repoRoot, file);
        const content = (await readFile(file, "utf8")).trimEnd();
        chunks.push(`// ───── source: ${rel} ${"─".repeat(Math.max(4, 68 - rel.length))}`);
        chunks.push("", content, "");
    }

    const merged = chunks.join("\n") + "\n";
    assertNoDuplicateDeclarations(merged);
    await writeFile(outputPath, merged, "utf8");

    console.log(
        `✔ merged ${partials.length} partial(s) -> ${path.relative(repoRoot, outputPath)}`,
    );
    for (const file of partials) console.log(`  • ${path.relative(repoRoot, file)}`);
};

main().catch((err) => {
    console.error("✖ schema merge failed:", err.message);
    process.exit(1);
});
