import { useCallback, useEffect, useRef, useState } from 'react';
import { aiApi, isBusy, isFinished, mergeMessages, type ChatMessage, type TaskView } from '../../api/endpoints/ai';
import { ApiError } from '../../api/errors';
import { useServices } from '../../app/services';

const MAX_POLL_FAILURES = 3;

export interface ChatState {
  messages: ChatMessage[];
  view: TaskView | null;
  taskId: string | null;
  sending: boolean;
  deciding: boolean;
  error: unknown;
  /** Polling gave up after repeated failures; the user can resume it. */
  stalled: boolean;
  loaded: boolean;
}

/**
 * Drives one conversation against the server's persisted tasks: sends a message, then polls the task until it needs
 * the user (approval / clarification) or finishes. Everything shown comes from server responses; nothing is assumed
 * to have happened until the server says so.
 */
export function useAssistantChat(conversationId: string | null, pollMs = 1000) {
  const { client } = useServices();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [view, setView] = useState<TaskView | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [stalled, setStalled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [pollVersion, setPollVersion] = useState(0);
  const afterSeq = useRef(0);

  // Switching conversations resets the view during render (React's recommended "adjust state on prop change"
  // pattern) instead of in an effect, so a stale transcript is never painted for the new conversation.
  const [forId, setForId] = useState(conversationId);
  if (forId !== conversationId) {
    setForId(conversationId);
    setMessages([]);
    setView(null);
    setTaskId(null);
    setError(null);
    setStalled(false);
    setLoaded(conversationId === null);
  }

  // Load the conversation from the server.
  useEffect(() => {
    afterSeq.current = 0;
    if (!conversationId) return;
    let cancelled = false;
    const controller = new AbortController();
    aiApi
      .conversation(client, conversationId, controller.signal)
      .then((detail) => {
        if (cancelled) return;
        // A message may already have been sent from this screen while the load was in flight: merge, never overwrite.
        setMessages((current) => mergeMessages(detail.messages, current));
        afterSeq.current = Math.max(
          afterSeq.current,
          detail.messages.reduce((max, m) => Math.max(max, m.seq), 0),
        );
        setTaskId((current) => current ?? detail.activeTaskId);
        setLoaded(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [client, conversationId]);

  // Poll the active task.
  useEffect(() => {
    if (!taskId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let stopped = false;

    const tick = async () => {
      try {
        const next = await aiApi.task(client, taskId, afterSeq.current, controller.signal);
        if (stopped) return;
        failures = 0;
        setMessages((current) => mergeMessages(current, next.messages));
        for (const m of next.messages) afterSeq.current = Math.max(afterSeq.current, m.seq);
        setView(next);
        // Keep polling only while the server is working; pause while the user must decide or it has finished.
        if (isBusy(next.task.status)) timer = setTimeout(() => void tick(), pollMs);
      } catch (e) {
        if (stopped || (ApiError.is(e) && e.kind === 'cancelled')) return;
        failures += 1;
        if (failures >= MAX_POLL_FAILURES || (ApiError.is(e) && !e.transient)) {
          setError(e);
          setStalled(true);
          return;
        }
        timer = setTimeout(() => void tick(), pollMs * 2);
      }
    };
    void tick();
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [client, taskId, pollVersion, pollMs]);

  const send = useCallback(
    async (text: string, locale: string, conversation: string) => {
      setSending(true);
      setError(null);
      setStalled(false);
      try {
        const task = await aiApi.send(client, conversation, text, locale);
        setView(null);
        setTaskId(task.id);
        setPollVersion((v) => v + 1);
      } catch (e) {
        setError(e);
        throw e;
      } finally {
        setSending(false);
      }
    },
    [client],
  );

  const decide = useCallback(async (action: () => Promise<unknown>) => {
    setDeciding(true);
    setError(null);
    try {
      await action();
      setPollVersion((v) => v + 1);
    } catch (e) {
      setError(e);
      setPollVersion((v) => v + 1); // the server state may have changed (expired, used): look again
    } finally {
      setDeciding(false);
    }
  }, []);

  const approve = useCallback(() => {
    const confirmation = view?.confirmation;
    if (!confirmation) return Promise.resolve();
    return decide(() => aiApi.approve(client, confirmation.id, confirmation.argsHash));
  }, [client, decide, view]);

  const reject = useCallback(() => {
    const confirmation = view?.confirmation;
    if (!confirmation) return Promise.resolve();
    return decide(() => aiApi.reject(client, confirmation.id));
  }, [client, decide, view]);

  const cancel = useCallback(() => {
    if (!taskId) return Promise.resolve();
    return decide(() => aiApi.cancel(client, taskId));
  }, [client, decide, taskId]);

  const resume = useCallback(() => {
    setError(null);
    setStalled(false);
    setPollVersion((v) => v + 1);
  }, []);

  const status = view?.task.status ?? null;
  return {
    messages,
    view,
    taskId,
    status,
    busy: status !== null && isBusy(status),
    awaiting: status === 'AWAITING_CONFIRMATION',
    finished: status !== null && isFinished(status),
    sending,
    deciding,
    error,
    stalled,
    loaded,
    send,
    approve,
    reject,
    cancel,
    resume,
  };
}
