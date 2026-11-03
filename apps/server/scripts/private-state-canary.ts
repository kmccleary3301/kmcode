#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off

/**
 * Local-only migration and reprojection canary.
 *
 * The source is opened read-only and is never used as a projection target. The
 * command leaves only an aggregate report in the requested output directory;
 * all copied databases and attachment roots are removed in the finalizer.
 */

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../src/config.ts";
import { runMigrations } from "../src/persistence/Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { OrchestrationProjectionPipeline } from "../src/orchestration/Services/ProjectionPipeline.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";

const REPORT_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
const MAX_REPORT_BYTES = 64 * 1024;

const FAILURE_INJECTIONS = [
  "permission",
  "disk",
  "migration",
  "corrupt-event",
  "unknown-provider",
  "stale-checkpoint",
] as const;
type FailureInjection = (typeof FAILURE_INJECTIONS)[number];

const parseArgs = (args: ReadonlyArray<string>) => {
  let source: string | undefined;
  let outputDir: string | undefined;
  let inject: FailureInjection | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--source" && value !== undefined) {
      source = value;
      index += 1;
    } else if (arg === "--output-dir" && value !== undefined) {
      outputDir = value;
      index += 1;
    } else if (arg === "--inject" && value !== undefined) {
      if (!(FAILURE_INJECTIONS as ReadonlyArray<string>).includes(value)) {
        throw new Error(`Unknown failure injection '${value}'.`);
      }
      inject = value as FailureInjection;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        `Usage: vp run private-state-canary --source /path/state.sqlite --output-dir /tmp/t3-canary [--inject ${FAILURE_INJECTIONS.join("|")}]\n`,
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument '${arg}'.`);
    }
  }
  if (source === undefined || outputDir === undefined) {
    throw new Error(
      "--source and --output-dir are required; the canary never selects a live path implicitly.",
    );
  }
  return { source: NodePath.resolve(source), outputDir: NodePath.resolve(outputDir), inject };
};

const quoteSqliteString = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const hashFile = (filePath: string): string => {
  const hash = NodeCrypto.createHash("sha256");
  hash.update(NodeFS.readFileSync(filePath));
  return hash.digest("hex");
};

const hashClass = (filePath: string): string => {
  try {
    const stat = NodeFS.statSync(filePath);
    return `${stat.size}:${hashFile(filePath).slice(0, 16)}`;
  } catch {
    return "missing";
  }
};

const removeDatabaseFiles = (databasePath: string): void => {
  for (const suffix of ["", "-wal", "-shm"]) {
    NodeFS.rmSync(`${databasePath}${suffix}`, { force: true });
  }
};

const makePrivateDirectory = (outputDir: string): void => {
  NodeFS.mkdirSync(outputDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  NodeFS.chmodSync(outputDir, PRIVATE_DIR_MODE);
  for (const entry of NodeFS.readdirSync(outputDir)) {
    if (entry === "REPORT.json") {
      NodeFS.rmSync(NodePath.join(outputDir, entry), { force: true });
      continue;
    }
    throw new Error("output directory must be empty except for a prior REPORT.json");
  }
};

const ensureSourceIsSafe = (source: string, outputDir: string): void => {
  if (!NodeFS.existsSync(source)) throw new Error("source database does not exist");
  if (!NodePath.isAbsolute(source) || !NodePath.isAbsolute(outputDir)) {
    throw new Error("source and output directory must be absolute paths");
  }
  const sourceReal = NodeFS.realpathSync(source);
  const sourceDirectory = NodeFS.realpathSync(NodePath.dirname(source));
  const outputReal = NodeFS.realpathSync(outputDir);
  if (
    sourceReal === outputReal ||
    sourceReal.startsWith(`${outputReal}${NodePath.sep}`) ||
    outputReal === sourceDirectory ||
    outputReal.startsWith(`${sourceDirectory}${NodePath.sep}`)
  ) {
    throw new Error("output directory must be outside the source database directory");
  }
  const runtimeState = NodePath.join(NodePath.dirname(source), "server-runtime.json");
  if (NodeFS.existsSync(runtimeState)) {
    throw new Error(
      "source directory has server-runtime.json; stop all T3 writers before running the canary",
    );
  }
};
const vacuumInto = (sourcePath: string, destinationPath: string): void => {
  const source = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
  try {
    source.exec(`VACUUM INTO ${quoteSqliteString(destinationPath)}`);
  } finally {
    source.close();
  }
};

const migrate = async (databasePath: string): Promise<void> => {
  const persistence = NodeSqliteClient.layer({ filename: databasePath }).pipe(
    Layer.provide(NodeServices.layer),
  );
  await Effect.runPromise(runMigrations().pipe(Effect.provide(persistence)));
};

type Aggregate = Readonly<{
  readonly events: number;
  readonly eventSequences: Readonly<{ readonly min: number | null; readonly max: number | null }>;
  readonly projects: number;
  readonly threads: number;
  readonly messages: number;
  readonly turns: number;
  readonly tasks: number;
  readonly checkpoints: number;
  readonly providers: number;
  readonly duplicateEventIds: number;
  readonly danglingThreadMessages: number;
  readonly danglingTurns: number;
  readonly integrity: string;
  readonly foreignKeys: number;
}>;

const tableCount = (db: NodeSqlite.DatabaseSync, table: string): number => {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count?: number };
    return Number(row.count ?? 0);
  } catch {
    return 0;
  }
};

const aggregate = (databasePath: string): Aggregate => {
  const db = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    const sequence = db
      .prepare("SELECT MIN(sequence) AS min, MAX(sequence) AS max FROM orchestration_events")
      .get() as { min?: number | null; max?: number | null };
    const duplicateEventIds = db
      .prepare(
        "SELECT COUNT(*) AS count FROM (SELECT event_id FROM orchestration_events GROUP BY event_id HAVING COUNT(*) > 1)",
      )
      .get() as { count?: number };
    const danglingThreadMessages = db
      .prepare(
        "SELECT COUNT(*) AS count FROM projection_thread_messages m LEFT JOIN projection_threads t ON t.thread_id = m.thread_id WHERE t.thread_id IS NULL",
      )
      .get() as { count?: number };
    const danglingTurns = db
      .prepare(
        "SELECT COUNT(*) AS count FROM projection_turns u LEFT JOIN projection_threads t ON t.thread_id = u.thread_id WHERE t.thread_id IS NULL",
      )
      .get() as { count?: number };
    const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string };
    const foreignKeys = db.prepare("PRAGMA foreign_key_check").all().length;
    return {
      events: tableCount(db, "orchestration_events"),
      eventSequences: { min: sequence.min ?? null, max: sequence.max ?? null },
      projects: tableCount(db, "projection_projects"),
      threads: tableCount(db, "projection_threads"),
      messages: tableCount(db, "projection_thread_messages"),
      turns: tableCount(db, "projection_turns"),
      tasks: tableCount(db, "projection_thread_activities"),
      checkpoints: tableCount(db, "checkpoint_diff_blobs"),
      providers: tableCount(db, "provider_session_runtime"),
      duplicateEventIds: Number(duplicateEventIds.count ?? 0),
      danglingThreadMessages: Number(danglingThreadMessages.count ?? 0),
      danglingTurns: Number(danglingTurns.count ?? 0),
      integrity: integrity.integrity_check ?? "unknown",
      foreignKeys,
    };
  } finally {
    db.close();
  }
};

const applySnapshotInjection = (
  databasePath: string,
  inject: FailureInjection | undefined,
): void => {
  if (inject === "disk") throw new Error("injected disk-full failure after private snapshot");
  if (inject === "migration")
    throw new Error("injected migration failure before migration execution");
  if (inject === "corrupt-event" || inject === "unknown-provider") {
    const db = new NodeSqlite.DatabaseSync(databasePath);
    try {
      const statement =
        inject === "corrupt-event"
          ? "UPDATE orchestration_events SET payload_json = '{not-json}' WHERE rowid = (SELECT MIN(rowid) FROM orchestration_events)"
          : "UPDATE orchestration_events SET event_type = 'provider.unknown.event' WHERE rowid = (SELECT MIN(rowid) FROM orchestration_events)";
      const result = db.prepare(statement).run();
      if (result.changes === 0) {
        throw new Error(`failure injection '${inject}' requires at least one orchestration event`);
      }
    } finally {
      db.close();
    }
  }
};

const copyEventHistory = (sourcePath: string, destinationPath: string): number => {
  const source = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
  const destination = new NodeSqlite.DatabaseSync(destinationPath);
  try {
    const columns = source
      .prepare("SELECT name FROM pragma_table_info('orchestration_events') ORDER BY cid")
      .all() as unknown as ReadonlyArray<{ name: string }>;
    if (columns.length === 0)
      throw new Error("orchestration_events table is missing from migrated snapshot");
    const names = columns.map((column) => `"${column.name.replaceAll('"', '""')}"`);
    const rows = source
      .prepare(`SELECT ${names.join(", ")} FROM orchestration_events ORDER BY rowid`)
      .all() as unknown as ReadonlyArray<Record<string, NodeSqlite.SQLInputValue>>;
    const placeholders = columns.map(() => "?").join(", ");
    const insert = destination.prepare(
      `INSERT INTO orchestration_events (${names.join(", ")}) VALUES (${placeholders})`,
    );
    destination.exec("PRAGMA foreign_keys = OFF; BEGIN");
    for (const row of rows) insert.run(...columns.map((column) => row[column.name] ?? null));
    destination.exec("COMMIT; PRAGMA foreign_keys = ON");
    return rows.length;
  } finally {
    source.close();
    destination.close();
  }
};

const reproject = async (databasePath: string): Promise<void> => {
  const persistence = makeSqlitePersistenceLive(databasePath).pipe(
    Layer.provide(NodeServices.layer),
  );
  const layer = OrchestrationProjectionPipelineLive.pipe(
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(persistence),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-private-canary-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const pipeline = yield* OrchestrationProjectionPipeline;
      yield* pipeline.bootstrap;
    }).pipe(Effect.provide(layer)),
  );
};

const writeReport = (outputDir: string, report: unknown): void => {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_REPORT_BYTES) {
    throw new Error("canary report exceeded aggregate evidence limit");
  }
  const reportPath = NodePath.join(outputDir, "REPORT.json");
  const temporaryPath = `${reportPath}.tmp-${process.pid}`;
  NodeFS.writeFileSync(temporaryPath, serialized, { mode: REPORT_MODE });
  NodeFS.chmodSync(temporaryPath, REPORT_MODE);
  NodeFS.renameSync(temporaryPath, reportPath);
  NodeFS.chmodSync(reportPath, REPORT_MODE);
};

const main = async (): Promise<void> => {
  const { source, outputDir, inject } = parseArgs(process.argv.slice(2));
  makePrivateDirectory(outputDir);
  ensureSourceIsSafe(source, outputDir);

  const report: {
    schemaVersion: 1;
    status: "passed" | "failed";
    phase: string;
    injection?: FailureInjection;
    sourceDigestBefore: string;
    sourceDigestAfter: string;
    sourceSidecars: Readonly<Record<string, string>>;
    migrated?: Aggregate;
    reprojected?: Aggregate;
    eventCount?: number;
    differences?: Readonly<
      Record<string, { readonly migrated: unknown; readonly reprojected: unknown }>
    >;
    failure?: string;
  } = {
    schemaVersion: 1,
    status: "failed",
    phase: "preflight",
    ...(inject === undefined ? {} : { injection: inject }),
    sourceDigestBefore: hashFile(source),
    sourceDigestAfter: "",
    sourceSidecars: {
      wal: hashClass(`${source}-wal`),
      shm: hashClass(`${source}-shm`),
    },
  };

  const migratedPath = NodePath.join(outputDir, "migrated.sqlite");
  const reprojectedPath = NodePath.join(outputDir, "reprojected.sqlite");
  try {
    if (inject === "permission")
      throw new Error("injected permission failure before private snapshot");
    report.phase = "snapshot";
    vacuumInto(source, migratedPath);
    applySnapshotInjection(migratedPath, inject);
    report.phase = "migration";
    await migrate(migratedPath);
    const migrated = aggregate(migratedPath);
    if (migrated.integrity !== "ok" || migrated.foreignKeys !== 0) {
      throw new Error("migrated snapshot failed integrity or foreign-key verification");
    }
    if (inject === "stale-checkpoint") {
      throw new Error("injected stale-checkpoint failure before canonical reprojection");
    }
    report.phase = "reprojection";
    // Reprojection must start from an empty, migrated schema. Copying the
    // migrated snapshot would retain projections and duplicate event history.
    const emptyReprojection = new NodeSqlite.DatabaseSync(reprojectedPath);
    emptyReprojection.close();
    await migrate(reprojectedPath);
    const eventCount = copyEventHistory(migratedPath, reprojectedPath);
    await reproject(reprojectedPath);
    const reprojected = aggregate(reprojectedPath);
    if (reprojected.integrity !== "ok" || reprojected.foreignKeys !== 0) {
      throw new Error("reprojected snapshot failed integrity or foreign-key verification");
    }
    const differences: Record<string, { migrated: unknown; reprojected: unknown }> = {};
    for (const key of [
      "events",
      "projects",
      "threads",
      "messages",
      "turns",
      "tasks",
      "checkpoints",
      "providers",
      "duplicateEventIds",
      "danglingThreadMessages",
      "danglingTurns",
    ] as const) {
      if (migrated[key] !== reprojected[key])
        differences[key] = { migrated: migrated[key], reprojected: reprojected[key] };
    }
    if (Object.keys(differences).length > 0)
      throw new Error("canonical aggregate comparison differed");
    report.phase = "cleanup";
    report.status = "passed";
    report.sourceDigestAfter = hashFile(source);
    Object.assign(report, { migrated, reprojected, eventCount, differences });
    if (report.sourceDigestBefore !== report.sourceDigestAfter)
      throw new Error("source database changed during canary");
  } catch (error) {
    report.sourceDigestAfter = hashFile(source);
    report.failure = error instanceof Error ? error.message : String(error);
    if (report.sourceDigestBefore !== report.sourceDigestAfter) {
      report.failure = "source database changed during failed canary";
    }
    writeReport(outputDir, report);
    throw error;
  } finally {
    removeDatabaseFiles(migratedPath);
    removeDatabaseFiles(reprojectedPath);
  }
  writeReport(outputDir, report);
  process.stdout.write(
    `Private canary passed; aggregate report: ${NodePath.join(outputDir, "REPORT.json")}\n`,
  );
};

await main();
