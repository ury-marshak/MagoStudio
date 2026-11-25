import type {
  LocalScriptChatMessageAccepted,
  LocalScriptChatMessageInput,
  LocalScriptChatMessages
} from "../../shared/contracts";
import {
  ScriptChatMessage,
  ScriptChatMessageRepository,
  ScriptChatReplyInFlightError
} from "../database/scriptChatMessageRepository";
import { runBackgroundTask } from "../libraryHealth";

import {
  buildScriptChatPrompt,
  buildScriptChatRepairPrompt,
  parseScriptChatReply,
  scriptChatReplyContent,
  toolDeclarations,
  trimHistoryToWordBudget,
  type ScriptChatReply,
  type ScriptChatToolDeclaration
} from "./scriptChatPrompt";

const HISTORY_DEFAULT_LIMIT = 20;
const HISTORY_MAX_LIMIT = 100;
const ORPHANED_ERROR =
  "the reply was interrupted before it finished (the app was closed or restarted)";
const CANCELLED_ERROR = "the reply was cancelled";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "the reply failed";

const toWireMessage = (message: ScriptChatMessage) => {
  const error = message.data.error;
  return {
    id: message.id,
    role: message.role,
    status: message.status,
    // Keep failed/PENDING rows readable by the renderer schema.
    content: message.content ?? "",
    error:
      error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : null,
    function_call: message.data.function_call ?? null,
    function_calls: message.data.function_calls ?? null,
    created_at: message.createdAt.toISOString()
  };
};

const newSession = () => ({
  lifetime: new AbortController(),
  running: new Map<string, AbortController>(),
  operations: new Map<string, Promise<unknown>>()
});
type Session = ReturnType<typeof newSession>;

/** Local chat rows and inference belong to one library session. Explicit
 * cancellation fails a turn; shutdown/library teardown leaves PENDING rows for
 * orphan recovery. A provider ignoring abort cannot repair or persist later. */
export class LocalScriptChatService {
  private session = newSession();

  constructor(
    private readonly messages: ScriptChatMessageRepository,
    private readonly assertLocalProject: (projectId: string) => Promise<void>,
    private readonly runChat: (
      prompt: string,
      signal?: AbortSignal
    ) => Promise<string | { content: string; model: string }>
  ) {}

  /** IPC captures this before asynchronous database setup so an old request
   * cannot be retargeted to a replacement library. */
  getSessionSignal(): AbortSignal {
    return this.session.lifetime.signal;
  }

  stop(): void {
    this.session.lifetime.abort();
  }

  /** Drain database work, not an uncooperative provider, before replacing the DB. */
  async suspend(): Promise<void> {
    this.stop();
    await Promise.allSettled(this.session.operations.values());
  }

  /** Only call after the replacement library has opened. */
  reset(): void {
    this.stop();
    this.session = newSession();
  }

  private inProject<T>(
    session: Session,
    projectId: string,
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const signal = session.lifetime.signal;
    const previous = session.operations.get(projectId);
    const task = (async () => {
      await previous?.catch(() => {});
      signal.throwIfAborted();
      return operation(signal);
    })();
    session.operations.set(projectId, task);
    const cleanup = () => {
      if (session.operations.get(projectId) === task)
        session.operations.delete(projectId);
    };
    void task.then(cleanup, cleanup);
    return task;
  }

  list(
    projectId: string,
    limit = HISTORY_DEFAULT_LIMIT
  ): Promise<LocalScriptChatMessages> {
    const session = this.session;
    return this.inProject(session, projectId, async (signal) => {
      await this.assertLocalProject(projectId);
      signal.throwIfAborted();
      await this.expireOrphans(session, projectId);
      signal.throwIfAborted();
      const rows = await this.messages.listRecent(
        projectId,
        Math.min(Math.max(1, Math.floor(limit)), HISTORY_MAX_LIMIT)
      );
      signal.throwIfAborted();
      return {
        project_id: projectId,
        pending: rows.some((row) => row.status === "PENDING"),
        messages: rows.map(toWireMessage)
      };
    });
  }

  post(
    input: LocalScriptChatMessageInput,
    profile?: AbortSignal
  ): Promise<LocalScriptChatMessageAccepted> {
    const session = this.session;
    return this.inProject(session, input.projectId, async (library) => {
      const signal = profile ? AbortSignal.any([library, profile]) : library;
      signal.throwIfAborted();
      await this.assertLocalProject(input.projectId);
      signal.throwIfAborted();
      const message = input.message.trim();
      if (!message) throw new Error("message is required");
      const tools = toolDeclarations(input.tools);
      await this.expireOrphans(session, input.projectId);
      signal.throwIfAborted();
      const [inFlight] = await this.messages.listPending(input.projectId);
      signal.throwIfAborted();
      if (inFlight) return this.accepted(inFlight);

      const systemPrompt =
        input.systemPrompt?.trim() ||
        (await this.messages.latestSystemPrompt(
          input.projectId,
          HISTORY_MAX_LIMIT
        ));
      signal.throwIfAborted();
      const historyLimit = Math.min(
        Math.max(1, Math.floor(input.historyMessages ?? HISTORY_MAX_LIMIT)),
        HISTORY_MAX_LIMIT
      );
      const rows = await this.messages.listRecent(
        input.projectId,
        historyLimit
      );
      signal.throwIfAborted();
      const history = trimHistoryToWordBudget(
        rows
          .filter((row) => row.status === "COMPLETED" && row.content?.trim())
          .map((row) => ({ role: row.role, content: row.content! })),
        message
      );
      let answer: ScriptChatMessage;
      try {
        ({ answer } = await this.messages.insertTurn({
          projectId: input.projectId,
          message,
          replyData: { system_prompt: systemPrompt }
        }));
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof ScriptChatReplyInFlightError)
          return this.accepted(error.inFlight);
        throw error;
      }
      signal.throwIfAborted();
      const controller = new AbortController();
      const turnSignal = AbortSignal.any([signal, controller.signal]);
      const forget = () => {
        if (session.running.get(answer.id) === controller)
          session.running.delete(answer.id);
      };
      session.running.set(answer.id, controller);
      // Retire the pending turn immediately; an abort-ignoring model must not
      // occupy the same project's chat slot in the replacement profile.
      turnSignal.addEventListener("abort", forget, { once: true });
      void runBackgroundTask("Script chat", () =>
        this.answer(
          session,
          input.projectId,
          answer.id,
          buildScriptChatPrompt({ systemPrompt, tools, history, message }),
          tools,
          turnSignal
        ).finally(() => {
          turnSignal.removeEventListener("abort", forget);
          forget();
        })
      );
      return this.accepted(answer);
    });
  }

  /** With an ID, a stale Cancel cannot cancel a newer turn. Without one,
   * cancel the project's currently pending turn, including an orphan. */
  cancel(projectId: string, messageId?: string): Promise<boolean> {
    const session = this.session;
    return this.inProject(session, projectId, async (signal) => {
      await this.assertLocalProject(projectId);
      signal.throwIfAborted();
      const pending = await this.messages.listPending(projectId);
      signal.throwIfAborted();
      const row = pending.find(
        (message) => !messageId || message.id === messageId
      );
      if (!row) return false;
      session.running.get(row.id)?.abort();
      return this.messages.finishReply(row.id, {
        status: "FAILED",
        error: CANCELLED_ERROR
      });
    });
  }

  private accepted(message: ScriptChatMessage): LocalScriptChatMessageAccepted {
    return {
      message_id: message.id,
      status: message.status,
      created_at: message.createdAt.toISOString()
    };
  }

  private async answer(
    session: Session,
    projectId: string,
    answerId: string,
    prompt: string,
    tools: ScriptChatToolDeclaration[],
    signal: AbortSignal
  ): Promise<void> {
    try {
      let reply: ScriptChatReply;
      let model = "local";
      const run = async (input: string) => {
        signal.throwIfAborted();
        const result = await this.runChat(input, signal);
        signal.throwIfAborted();
        if (typeof result === "string") {
          model = "local";
          return result;
        }
        model = result.model;
        return result.content;
      };
      const answer = await run(prompt);
      try {
        reply = parseScriptChatReply(answer, tools);
      } catch (firstError) {
        signal.throwIfAborted();
        reply = parseScriptChatReply(
          await run(
            buildScriptChatRepairPrompt(prompt, errorMessage(firstError))
          ),
          tools
        );
      }
      await this.inProject(session, projectId, async () => {
        signal.throwIfAborted();
        await this.messages.finishReply(answerId, {
          status: "COMPLETED",
          model,
          content: scriptChatReplyContent(reply),
          functionCall: reply.functionCall,
          functionCalls: reply.functionCalls
        });
      });
    } catch (error) {
      // Explicit cancel owns its FAILED write; teardown preserves orphan recovery.
      if (signal.aborted) return;
      console.error("Local script chat reply failed", error);
      await this.inProject(session, projectId, async () => {
        signal.throwIfAborted();
        await this.messages.finishReply(answerId, {
          status: "FAILED",
          error: errorMessage(error)
        });
      }).catch((writeError: unknown) => {
        if (!signal.aborted)
          console.error("Could not record the failed chat reply", writeError);
      });
    }
  }

  private async expireOrphans(
    session: Session,
    projectId: string
  ): Promise<void> {
    const signal = session.lifetime.signal;
    for (const row of await this.messages.listPending(projectId)) {
      signal.throwIfAborted();
      if (session.running.has(row.id)) continue;
      await this.messages.finishReply(row.id, {
        status: "FAILED",
        error: ORPHANED_ERROR
      });
    }
  }
}
