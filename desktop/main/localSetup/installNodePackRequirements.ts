import { stat } from "node:fs/promises";
import path from "node:path";

import { runSetupProcess } from "./runSetupProcess";

export type PythonProcessRunner = (
  python: string,
  args: string[],
  signal?: AbortSignal
) => Promise<{ exitCode: number | null; output: string }>;

const PIP_ERROR_TAIL_LINES = 6;

export const runPythonProcess: PythonProcessRunner = runSetupProcess;

export const requirementsFileOfNodePack = (nodePackDirectory: string) =>
  path.join(nodePackDirectory, "requirements.txt");

export const describePipInstallCommand = (
  python: string,
  nodePackDirectory: string
) =>
  `"${python}" -s -m pip install -r "${requirementsFileOfNodePack(nodePackDirectory)}"`;

export const installNodePackRequirements = async ({
  python,
  nodePackDirectory,
  signal,
  runPython = runPythonProcess,
  log = console.info
}: {
  python: string;
  nodePackDirectory: string;
  signal?: AbortSignal;
  runPython?: PythonProcessRunner;
  log?: (message: string) => void;
}): Promise<"installed" | "no-requirements"> => {
  const requirementsFile = requirementsFileOfNodePack(nodePackDirectory);
  const hasRequirementsFile = await stat(requirementsFile)
    .then((info) => info.isFile())
    .catch(() => false);
  signal?.throwIfAborted();
  if (!hasRequirementsFile) return "no-requirements";
  const { exitCode, output } = await runPython(
    python,
    ["-s", "-m", "pip", "install", "-r", requirementsFile],
    signal
  );
  signal?.throwIfAborted();
  log(`pip install for ${path.basename(nodePackDirectory)}:\n${output}`);
  if (exitCode === 0) return "installed";
  const lastLines = output
    .trim()
    .split(/\r?\n/)
    .slice(-PIP_ERROR_TAIL_LINES)
    .join("\n");
  throw new Error(
    `Installing the dependencies of ${path.basename(nodePackDirectory)} failed:\n${lastLines}`
  );
};
