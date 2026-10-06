import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"

import {
  isProjectLocalImport,
  noServiceConstructorImportsRule,
} from "./no-service-constructor-imports.ts"

const importNode = (source: string) => ({
  source: { value: source },
  specifiers: [
    {
      type: "ImportSpecifier",
      imported: { type: "Identifier", name: "makePaymentService" },
    },
  ],
})

const reportCount = (source: string, filename = "src/runtime.ts") => {
  const reports: unknown[] = []
  const visitor = noServiceConstructorImportsRule.create({
    filename,
    options: [{ internalImportPrefixes: ["@pay-tty/"] }],
    report(diagnostic: unknown) {
      reports.push(diagnostic)
    },
  })

  visitor.ImportDeclaration?.(importNode(source))
  return reports.length
}

void test("recognizes relative and configured internal imports", () => {
  assert.equal(isProjectLocalImport("../service.ts", []), true)
  assert.equal(isProjectLocalImport("@pay-tty/ledger-client", ["@pay-tty/"]), true)
})

void test("does not classify external packages as project-local", () => {
  assert.equal(isProjectLocalImport("effect", ["@pay-tty/"]), false)
  assert.equal(reportCount("effect"), 0)
})

void test("reports service constructors imported through a workspace alias", () => {
  assert.equal(reportCount("@pay-tty/ledger-client"), 1)
})

void test("preserves the test-file exemption", () => {
  assert.equal(reportCount("@pay-tty/ledger-client", "src/runtime.test.ts"), 0)
})

void test("the registered plugin rejects aliases but accepts external imports", () => {
  const projectRoot = resolve(import.meta.dirname, "../../../../..")
  const executable = resolve(
    projectRoot,
    "node_modules/.bin",
    process.platform === "win32" ? "oxlint.CMD" : "oxlint",
  )
  const plugin = resolve(import.meta.dirname, "../index.ts")
  const directory = mkdtempSync(join(tmpdir(), "anti-slop-alias-test-"))

  try {
    const config = join(directory, ".oxlintrc.json")
    const accepted = join(directory, "accepted.ts")
    const rejected = join(directory, "rejected.ts")

    writeFileSync(
      config,
      JSON.stringify({
        jsPlugins: [{ name: "anti-slop-effect", specifier: plugin }],
        rules: {
          "anti-slop-effect/no-service-constructor-imports": [
            "error",
            { internalImportPrefixes: ["@pay-tty/"] },
          ],
        },
      }),
    )
    writeFileSync(
      accepted,
      'import { makeExternalService } from "external-package"\nvoid makeExternalService\n',
    )
    writeFileSync(
      rejected,
      'import { makePaymentService } from "@pay-tty/ledger-client"\nvoid makePaymentService\n',
    )

    const acceptedResult = spawnSync(executable, ["--config", config, accepted], {
      encoding: "utf8",
    })
    assert.equal(acceptedResult.status, 0, acceptedResult.stderr)

    const rejectedResult = spawnSync(executable, ["--config", config, rejected], {
      encoding: "utf8",
    })
    assert.equal(rejectedResult.status, 1)
    assert.match(
      `${rejectedResult.stdout}${rejectedResult.stderr}`,
      /anti-slop-effect\(no-service-constructor-imports\)/u,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
