"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff, PhoneOff, Sparkles, X } from "lucide-react";
import { workspaceHeaders } from "@/lib/client-workspace";

type Props = {
  teamId: string;
  agentId: string;
  members: { id: string; name: string; title: string }[];
  onSelectAgent: (id: string) => void;
  initiallyOpen?: boolean;
  apiKey: string;
  connected: boolean;
  disabled?: boolean;
  teamName: string;
  currentTask?: string;
  onNeedKey: () => void;
};

type LiveEvent = {
  type?: string;
  delta?: string;
  transcript?: string;
  offset_ms?: number;
  delegation?: { id?: string; target?: string; offset_ms?: number };
};

type InputTurn = { text: string; offsetMs: number };
export default function LiveVoice({
  teamId,
  agentId,
  members,
  onSelectAgent,
  initiallyOpen = false,
  apiKey,
  connected,
  disabled,
  teamName,
  currentTask,
  onNeedKey,
}: Props) {
  const [open, setOpen] = useState(initiallyOpen);
  const speakerName = members.find((member) => member.id === agentId)?.name;
  const [state, setState] = useState<
    "idle" | "connecting" | "live" | "ending" | "error"
  >("idle");
  const [status, setStatus] = useState("Ready when you are");
  const [heard, setHeard] = useState("");
  const [reply, setReply] = useState("");
  const [muted, setMuted] = useState(false);
  const peer = useRef<RTCPeerConnection | null>(null);
  const events = useRef<RTCDataChannel | null>(null);
  const microphone = useRef<MediaStream | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const closeTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelIceWait = useRef<(() => void) | null>(null);
  const currentInput = useRef<InputTurn>({ text: "", offsetMs: 0 });
  const inputTurns = useRef<InputTurn[]>([]);
  const attempt = useRef(0);

  const cleanup = useCallback(() => {
    attempt.current += 1;
    if (closeTimeout.current) clearTimeout(closeTimeout.current);
    cancelIceWait.current?.();
    microphone.current?.getTracks().forEach((track) => track.stop());
    events.current?.close();
    peer.current?.close();
    if (audio.current) audio.current.srcObject = null;
    microphone.current = null;
    events.current = null;
    peer.current = null;
    cancelIceWait.current = null;
    setMuted(false);
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const handleEvent = useCallback(
    (event: LiveEvent) => {
      if (event.type === "session.started") {
        setState("live");
        setStatus("Listening");
      } else if (event.type === "session.input_transcript.delta" && event.delta) {
        currentInput.current = {
          text: (currentInput.current.text + event.delta).slice(-600),
          offsetMs: event.offset_ms ?? currentInput.current.offsetMs,
        };
        setHeard(currentInput.current.text.slice(-260));
        setStatus("Listening to you…");
      } else if (event.type === "session.input_transcript.done") {
        const text = (event.transcript || currentInput.current.text).trim();
        if (text) {
          inputTurns.current = [
            ...inputTurns.current.slice(-5),
            { text, offsetMs: event.offset_ms ?? currentInput.current.offsetMs },
          ];
          setHeard(text.slice(-260));
        }
        currentInput.current = { text: "", offsetMs: 0 };
      } else if (event.type === "session.delegation.created") {
        if (event.delegation?.id && events.current?.readyState === "open") {
          events.current.send(JSON.stringify({
            type: "session.commentary.append",
            event_id: `conversation_${Date.now()}`,
            delegation_id: event.delegation.id,
            content: "This is a conversation with the studio owner. Answer directly from the roster and conversation. No task was created or operation performed. Live task status is not connected; if needed say that briefly without inventing progress or asking for Add task. You may discuss plans and acknowledge direction in character.",
          }));
          setStatus("Listening");
        }
      } else if (
        event.type === "session.output_transcript.delta" &&
        event.delta
      ) {
        setReply((value) => (value + event.delta).slice(-260));
        setStatus("Constellation is replying…");
      } else if (event.type === "session.output_transcript.done") {
        setStatus("Listening");
      } else if (event.type === "session.closed") {
        cleanup();
        setState("idle");
        setStatus("Conversation ended");
      }
    },
    [cleanup],
  );

  const start = async () => {
    const attemptId = ++attempt.current;
    setOpen(true);
    setHeard("");
    setReply("");
    currentInput.current = { text: "", offsetMs: 0 };
    inputTurns.current = [];
    if (!connected) {
      setStatus("Connect an API key to talk");
      onNeedKey();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
      setState("error");
      setStatus("This browser does not support live voice.");
      return;
    }

    setState("connecting");
    setStatus("Connecting to GPT-Live 1…");
    try {
      const connection = new RTCPeerConnection();
      peer.current = connection;
      connection.addEventListener("track", (event) => {
        if (attempt.current !== attemptId) {
          event.track.stop();
          return;
        }
        if (!audio.current) return;
        audio.current.srcObject = new MediaStream([event.track]);
        void audio.current.play().catch(() => {
          setStatus("Select play in your browser to hear the team.");
        });
      });

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (attempt.current !== attemptId) {
        stream.getTracks().forEach((track) => track.stop());
        connection.close();
        return;
      }
      microphone.current = stream;
      for (const track of stream.getAudioTracks()) connection.addTrack(track, stream);

      const channel = connection.createDataChannel("oai-events");
      events.current = channel;
      channel.addEventListener("message", ({ data }) => {
        if (attempt.current !== attemptId || events.current !== channel) return;
        try {
          handleEvent(JSON.parse(String(data)) as LiveEvent);
        } catch {
          setStatus("Voice event could not be read.");
        }
      });
      channel.addEventListener("close", () => {
        if (peer.current !== connection) return;
        cleanup();
        setState("idle");
      });

      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      if (attempt.current !== attemptId) return;
      if (connection.iceGatheringState !== "complete") {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (next: () => void) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timeout);
            connection.removeEventListener("icegatheringstatechange", onState);
            cancelIceWait.current = null;
            next();
          };
          const timeout = window.setTimeout(() => {
            finish(() => reject(new Error("Voice connection timed out.")));
          }, 10_000);
          function onState() {
            if (connection.iceGatheringState !== "complete") return;
            finish(resolve);
          }
          cancelIceWait.current = () => finish(resolve);
          connection.addEventListener("icegatheringstatechange", onState);
          onState();
        });
      }

      const sdp = connection.localDescription?.sdp;
      if (!sdp) throw new Error("Missing voice connection offer.");
      const response = await fetch("/api/live", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...workspaceHeaders(),
          ...(apiKey ? { "x-model-key": apiKey } : {}),
        },
        body: JSON.stringify({ sdp, teamId, agentId: agentId || undefined }),
      });
      const result = (await response.json()) as {
        error?: string;
        transport?: { sdp?: string };
      };
      if (!response.ok || !result.transport?.sdp)
        throw new Error(result.error || "GPT-Live did not return an answer.");
      if (attempt.current !== attemptId) return;
      await connection.setRemoteDescription({
        type: "answer",
        sdp: result.transport.sdp,
      });
    } catch (error) {
      if (attempt.current !== attemptId) return;
      cleanup();
      setState("error");
      setStatus((error as Error).message);
    }
  };

  const end = () => {
    if (events.current?.readyState !== "open") {
      cleanup();
      setState("idle");
      return;
    }
    setState("ending");
    setStatus("Wrapping up…");
    events.current.send(JSON.stringify({ type: "session.close" }));
    closeTimeout.current = setTimeout(() => {
      cleanup();
      setState("idle");
      setStatus("Conversation ended");
    }, 15_000);
  };

  const toggleMute = () => {
    const next = !muted;
    microphone.current?.getAudioTracks().forEach((track) => {
      track.enabled = !next;
    });
    setMuted(next);
    setStatus(next ? "Microphone muted" : "Listening");
  };

  return (
    <>
      <button
        className="voice-trigger"
        disabled={disabled || state === "connecting" || state === "ending"}
        onClick={() => (state === "live" ? setOpen(true) : void start())}
      >
        <Mic size={16} />
        {speakerName ? `Talk to ${speakerName}` : "Talk to team"}
      </button>
      {open && (
        <section className={`live-voice-panel ${state}`} aria-live="polite">
          <audio ref={audio} aria-hidden="true" />
          <div className="voice-panel-top">
            <div className="voice-orb" aria-hidden="true">
              <span />
              <Sparkles size={16} />
            </div>
            <div>
              <b>{speakerName ? `${speakerName} · ${teamName}` : `${teamName} voice room`}</b>
              <small>GPT-Live 1 · {status}</small>
            </div>
            <button
              className="voice-close"
              aria-label="Close voice panel"
              onClick={() => {
                if (events.current?.readyState === "open") {
                  events.current.send(JSON.stringify({ type: "session.close" }));
                }
                cleanup();
                setState("idle");
                setOpen(false);
              }}
            >
              <X size={16} />
            </button>
          </div>
          <div className="voice-copy">
            <label htmlFor="voice-teammate">Talk with</label>
            <select
              id="voice-teammate"
              className="hearth-text-input"
              value={agentId}
              onChange={(event) => onSelectAgent(event.target.value)}
            >
              <option value="">Whole team</option>
              {members.map((member) => <option key={member.id} value={member.id}>{member.name} · {member.title}</option>)}
            </select>
            <p className="voice-prompt">Switching teammates ends this call. Select Start talking for their voice.</p>
            {heard ? (
              <p>
                <span>You</span>
                {heard}
              </p>
            ) : (
              <p className="voice-prompt">
                “Hey team, what do you think of this idea?”
              </p>
            )}
            {reply && (
              <p>
                <span>{speakerName || "Constellation"}</span>
                {reply}
              </p>
            )}
          </div>
          {currentTask && <div className="voice-task">Current · {currentTask}</div>}
          <div className="voice-controls">
            {state === "live" ? (
              <>
                <button onClick={toggleMute} className={muted ? "muted" : ""}>
                  {muted ? <MicOff size={16} /> : <Mic size={16} />}
                  {muted ? "Unmute" : "Mute"}
                </button>
                <button className="end-call" onClick={end}>
                  <PhoneOff size={16} /> End
                </button>
              </>
            ) : (
              <button
                onClick={() => void start()}
                disabled={state === "connecting" || state === "ending"}
              >
                <Mic size={16} />
                {state === "connecting" ? "Connecting…" : "Start talking"}
              </button>
            )}
          </div>
        </section>
      )}
    </>
  );
}
