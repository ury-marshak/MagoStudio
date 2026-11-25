import { stat } from "node:fs/promises";
import path from "node:path";

import type { NodePackDependenciesOutcome } from "../../shared/contracts";
import { asRecord } from "../comfy/asRecord";
import { ComfyClient } from "../comfy/ComfyClient";

import { findComfyPython } from "./findComfyPython";
import {
  describePipInstallCommand,
  installNodePackRequirements,
  requirementsFileOfNodePack
} from "./installNodePackRequirements";
import type { SetupAttempt } from "./setupAttempt";

const LOCAL_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];
const PYTHON_PLACEHOLDER = "<ComfyUI Python>";

const isEndpointOnThisComputer = (endpoint: string) => {
  try {
    return LOCAL_HOSTNAMES.includes(new URL(endpoint).hostname);
  } catch {
    return false;
  }
};

const readReportedPythonVersion = async (
  endpoint: string,
  signal?: AbortSignal
) => {
  signal?.throwIfAborted();
  const systemStats = await new ComfyClient(endpoint, undefined, signal)
    .getJson("/system_stats")
    .catch(() => null);
  signal?.throwIfAborted();
  const pythonVersion = asRecord(asRecord(systemStats)?.system)?.python_version;
  return typeof pythonVersion === "string" ? pythonVersion : null;
};

export const installManualNodePackDependencies = async ({
  nodePackDirectory,
  endpoint,
  signal,
  attempt
}: {
  nodePackDirectory: string;
  endpoint: string;
  signal?: AbortSignal;
  attempt?: SetupAttempt;
}): Promise<NodePackDependenciesOutcome> => {
  const hasRequirementsFile = await stat(
    requirementsFileOfNodePack(nodePackDirectory)
  )
    .then((info) => info.isFile())
    .catch(() => false);
  signal?.throwIfAborted();
  if (!hasRequirementsFile) return { outcome: "no-requirements" };
  const issue = <T>(work: () => Promise<T>) =>
    attempt ? attempt.issue(work) : work();
  const reportedPythonVersion = isEndpointOnThisComputer(endpoint)
    ? await readReportedPythonVersion(endpoint, signal)
    : null;
  signal?.throwIfAborted();
  const comfyPython = reportedPythonVersion
    ? await issue(() =>
        findComfyPython({
          comfyDirectory: path.dirname(path.dirname(nodePackDirectory)),
          reportedPythonVersion,
          ...(signal && { signal })
        })
      )
    : null;
  signal?.throwIfAborted();
  if (!comfyPython)
    return {
      outcome: "manual",
      pipCommand: describePipInstallCommand(
        PYTHON_PLACEHOLDER,
        nodePackDirectory
      )
    };
  try {
    const outcome = await issue(() =>
      installNodePackRequirements({
        python: comfyPython,
        nodePackDirectory,
        signal
      })
    );
    signal?.throwIfAborted();
    return { outcome };
  } catch (error) {
    signal?.throwIfAborted();
    return {
      outcome: "manual",
      pipCommand: describePipInstallCommand(comfyPython, nodePackDirectory),
      failureReason: error instanceof Error ? error.message : String(error)
    };
  }
};
