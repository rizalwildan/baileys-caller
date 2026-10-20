/**
 * baileys-caller — WhatsApp voice calling for Node.js.
 *
 * Wraps WhatsApp Web's official VoIP WASM stack and routes signaling through
 * Baileys. Public surface:
 *
 *   const client = new VoipClient({ authDir })
 *   await client.connect()
 *   const call = await client.call("12345678901", { audioSource: "./hi.mp3" })
 *
 * @author ShellTear
 */
import { EventEmitter } from "node:events";
import { WasmEngine } from "./wasm-engine.mjs";
import { CallState, type VoipSdkConfig } from "./types.mjs";
export type { VoipSdkConfig, CallOptions, CallEvents, AudioConfig } from "./types.mjs";
export { CallState } from "./types.mjs";
/** A live or recently-ended call. */
export declare class ActiveCall extends EventEmitter {
    #private;
    readonly callId: string;
    private readonly engine;
    /** @internal mirrors the source path for the audio feeder */
    _audioSource: string;
    constructor(callId: string, engine: WasmEngine, durationMs: number);
    get state(): CallState;
    end: (reason?: string) => void;
    mute: (muted: boolean) => void;
    waitForEnd: () => Promise<string>;
    /** @internal — called by VoipClient on WASM call-state change */
    _updateState: (state: number) => void;
    /**
     * @internal — the callee's side ended a call that was never answered. WhatsApp tells us with a `reject` (declined)
     * or a `terminate` (`reason="timeout"` when it rang out) stanza, and the engine does not always turn either into a
     * state change, so without this the call would ring until the caller's own timeout. An answered call is left to the engine.
     * Ends through `end()`, not `_forceEnd()`: the engine must leave the call too, or it ignores the next `startCall` and
     * that call never rings.
     */
    _peerEnded: (tag: string, reason?: string) => void;
    /**
     * @internal — notes why the callee's side is ending an unanswered call, before its stanza reaches the engine. The
     * engine may react to that stanza with a state change that ends the call first, and that change alone says only
     * "ended"; with the note it reports `no_answer` / `remote_end` like `_peerEnded` would.
     */
    _notePeerEnd: (tag: string, reason?: string) => void;
    /** @internal — engine event 11: the callee declined. */
    _peerRejected: () => void;
    /** @internal */
    _emitAudio: (pcm: Float32Array) => void;
    /** @internal */
    _forceEnd: (reason: string) => void;
}
/** Top-level client. Connects to WhatsApp and lets you place calls. */
export declare class VoipClient {
    #private;
    constructor(config: VoipSdkConfig);
    /** Connect to WhatsApp and bring up the WASM VoIP stack. */
    connect: () => Promise<void>;
    /** Place an outbound voice call. */
    call: (phoneNumber: string, opts?: {
        audioSource?: string;
        durationMs?: number;
    }) => Promise<ActiveCall>;
    /**
     * Push one 16 kHz mono f32 frame of the local (caller) side into the WhatsApp
     * uplink. Dropped until the WASM starts asking for capture, i.e. until the
     * callee has answered (`AudioFeeder` is created on capture start).
     */
    write: (pcm: Float32Array) => void;
    /** True once the socket is open — a populated `authDir` opens without a QR scan. */
    isOpen: () => boolean;
    /**
     * Why the socket is down after having been open, or null while it is open (or was never opened):
     * `"reconnecting"` while it is being reopened, or the reason it was given up on — `"logged_out"`, `"replaced"`,
     * `"forbidden"`, `"bad_session"`, `"multidevice_mismatch"`. A given-up socket stays down until `connect()` runs
     * again in a new client (in practice: the service restarts, or the worker is re-linked).
     */
    disconnectReason: () => string | null;
    /** Tear down the WhatsApp socket and release resources. */
    disconnect: () => void;
}
