/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleGenAI, LiveServerMessage, Modality, Session} from '@google/genai';
import {LitElement, css, html} from 'lit';
import {customElement, state} from 'lit/decorators.js';
import {classMap} from 'lit/directives/class-map.js';
import {createBlob, decode, decodeAudioData} from './utils';
import './visual-3d';

const VOICES = ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir'];
const LOCAL_STORAGE_KEY = 'gemini-live-audio-session';

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() status = 'Welcome! Press the microphone to start.';
  @state() error = '';
  @state() transcriptHistory: Array<{speaker: string; text: string}> = [];
  @state() currentInputTranscription = '';
  @state() currentOutputTranscription = '';
  @state() selectedVoice = 'Zephyr';

  private client: GoogleGenAI;
  private sessionPromise: Promise<Session>;
  // FIX: Cast window to any to access webkitAudioContext for broader browser support.
  private inputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 16000});
  // FIX: Cast window to any to access webkitAudioContext for broader browser support.
  private outputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 24000});
  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();
  private nextStartTime = 0;
  private mediaStream: MediaStream;
  private sourceNode: MediaStreamAudioSourceNode;
  private scriptProcessorNode: ScriptProcessorNode;
  private sources = new Set<AudioBufferSourceNode>();

  static styles = css`
    :host {
      display: block;
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      position: relative;
      background-color: #100c14;
      color: white;
      font-family: 'Google Sans', 'Helvetica Neue', sans-serif;
    }

    #status {
      position: absolute;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 20;
      text-align: center;
      background: rgba(0, 0, 0, 0.5);
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 14px;
      max-width: 80%;
      backdrop-filter: blur(5px);
    }

    .controls {
      z-index: 10;
      position: absolute;
      bottom: 5vh;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 16px;
      background: rgba(30, 30, 30, 0.5);
      padding: 12px;
      border-radius: 99px;
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.1);
    }

    .controls button,
    .controls select {
      outline: none;
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: white;
      background: rgba(255, 255, 255, 0.1);
      width: 56px;
      height: 56px;
      cursor: pointer;
      font-size: 24px;
      padding: 0;
      margin: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background-color 0.2s;
      border-radius: 50%;
    }

    .controls button:hover,
    .controls select:hover {
      background: rgba(255, 255, 255, 0.2);
    }

    .controls button.recording {
      background-color: #db3125;
      border-color: #db3125;
    }

    .controls select {
      width: auto;
      height: 56px;
      border-radius: 28px;
      padding: 0 45px 0 20px;
      -webkit-appearance: none;
      -moz-appearance: none;
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 1rem center;
      background-size: 1em;
      font-size: 16px;
      font-weight: 500;
    }

    #transcript-container {
      position: absolute;
      top: 20px;
      left: 20px;
      bottom: 20vh;
      width: 350px;
      background: rgba(30, 30, 30, 0.5);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      padding: 16px;
      overflow-y: auto;
      z-index: 5;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .transcript-entry {
      line-height: 1.5;
      font-size: 15px;
    }

    .transcript-entry strong {
      color: #87ceeb;
      font-weight: 600;
    }

    .current-transcript {
      color: rgba(255, 255, 255, 0.7);
    }

    /* Responsive Design */
    @media (max-width: 768px) {
      #transcript-container {
        left: 10px;
        right: 10px;
        width: auto;
        bottom: calc(5vh + 100px);
        top: 10vh;
      }
      .controls {
        width: 90%;
        justify-content: space-around;
        flex-wrap: wrap;
      }
    }
  `;

  constructor() {
    super();
    this.loadSessionOnStartup();
    this.initClient();
  }

  private initAudio() {
    this.nextStartTime = this.outputAudioContext.currentTime;
  }

  private async initClient() {
    this.initAudio();

    this.client = new GoogleGenAI({
      apiKey: process.env.API_KEY,
    });

    this.outputNode.connect(this.outputAudioContext.destination);

    this.initSession();
  }

  private async initSession() {
    const model = 'gemini-2.5-flash-native-audio-preview-09-2025';

    this.updateError('');
    this.updateStatus('Initializing session...');

    this.sessionPromise = this.client.live.connect({
      model: model,
      callbacks: {
        onopen: () => {
          this.updateStatus('Session opened. Ready to talk!');
        },
        onmessage: async (message: LiveServerMessage) => {
          const audio = message.serverContent?.modelTurn?.parts[0]?.inlineData;

          if (audio) {
            this.nextStartTime = Math.max(
              this.nextStartTime,
              this.outputAudioContext.currentTime,
            );

            const audioBuffer = await decodeAudioData(
              decode(audio.data),
              this.outputAudioContext,
              24000,
              1,
            );
            const source = this.outputAudioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(this.outputNode);
            source.addEventListener('ended', () => {
              this.sources.delete(source);
            });

            source.start(this.nextStartTime);
            this.nextStartTime = this.nextStartTime + audioBuffer.duration;
            this.sources.add(source);
          }

          if (message.serverContent?.outputTranscription) {
            this.currentOutputTranscription +=
              message.serverContent.outputTranscription.text;
          } else if (message.serverContent?.inputTranscription) {
            this.currentInputTranscription +=
              message.serverContent.inputTranscription.text;
          }

          if (message.serverContent?.turnComplete) {
            const fullInput = this.currentInputTranscription;
            const fullOutput = this.currentOutputTranscription;

            const newHistory = [...this.transcriptHistory];
            if (fullInput.trim()) {
              newHistory.push({speaker: 'You', text: fullInput});
            }
            if (fullOutput.trim()) {
              newHistory.push({speaker: 'Gemini', text: fullOutput});
            }
            this.transcriptHistory = newHistory;

            this.currentInputTranscription = '';
            this.currentOutputTranscription = '';
          }

          const interrupted = message.serverContent?.interrupted;
          if (interrupted) {
            for (const source of this.sources.values()) {
              source.stop();
              this.sources.delete(source);
            }
            this.nextStartTime = 0;
          }
        },
        onerror: (e: ErrorEvent) => {
          this.updateError(`Error: ${e.message}`);
          this.stopRecording();
        },
        onclose: (e: CloseEvent) => {
          this.updateStatus('Session closed.');
        },
      },
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {voiceName: this.selectedVoice},
          },
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    });

    this.sessionPromise.catch((e) => {
      this.updateError(e.message);
      this.stopRecording();
    });
  }

  private updateStatus(msg: string) {
    this.status = msg;
    this.error = '';
  }

  private updateError(msg: string) {
    this.error = msg;
    this.status = '';
  }

  private toggleRecording() {
    if (this.isRecording) {
      this.stopRecording();
    } else {
      this.startRecording();
    }
  }

  private async startRecording() {
    if (this.isRecording) return;
    this.inputAudioContext.resume();
    this.updateStatus('Requesting microphone access...');

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });

      this.updateStatus('Microphone connected.');

      this.sourceNode = this.inputAudioContext.createMediaStreamSource(
        this.mediaStream,
      );
      this.sourceNode.connect(this.inputNode);

      const bufferSize = 4096;
      this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(
        bufferSize,
        1,
        1,
      );

      this.scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
        if (!this.isRecording) return;
        const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
        this.sessionPromise.then((session) => {
          session.sendRealtimeInput({media: createBlob(inputData)});
        });
      };

      this.sourceNode.connect(this.scriptProcessorNode);
      this.scriptProcessorNode.connect(this.inputAudioContext.destination);

      this.isRecording = true;
      this.updateStatus('🔴 Recording...');
    } catch (err) {
      this.updateError(`Error starting recording: ${err.message}`);
      this.stopRecording();
    }
  }

  private stopRecording() {
    if (!this.isRecording && !this.mediaStream && !this.inputAudioContext)
      return;

    this.isRecording = false;
    this.updateStatus('Recording stopped.');

    if (this.scriptProcessorNode && this.sourceNode) {
      this.scriptProcessorNode.disconnect();
      this.sourceNode.disconnect();
      this.scriptProcessorNode = null;
      this.sourceNode = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
  }

  private reinitSession() {
    this.stopRecording();
    if (this.sessionPromise) {
      this.sessionPromise.then((session) => session.close());
    }
    this.currentInputTranscription = '';
    this.currentOutputTranscription = '';
    this.initSession();
  }

  private reset() {
    this.transcriptHistory = [];
    this.reinitSession();
    this.updateStatus('Session cleared.');
  }

  private handleVoiceChange(e: Event) {
    this.selectedVoice = (e.target as HTMLSelectElement).value;
    this.reinitSession();
    this.updateStatus(`Voice changed to ${this.selectedVoice}.`);
  }

  private exportTranscript() {
    if (this.transcriptHistory.length === 0) {
      this.updateStatus('Transcript is empty.');
      return;
    }

    let transcriptText = 'Conversation Transcript\n\n';
    this.transcriptHistory.forEach((entry) => {
      transcriptText += `${entry.speaker}: ${entry.text}\n\n`;
    });

    const blob = new Blob([transcriptText], {type: 'text/plain'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'transcript.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  private saveSession() {
    if (this.transcriptHistory.length === 0) {
      this.updateStatus('Nothing to save.');
      return;
    }
    const sessionData = {
      transcriptHistory: this.transcriptHistory,
      selectedVoice: this.selectedVoice,
    };
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(sessionData));
      this.updateStatus('Session saved successfully!');
    } catch (error) {
      this.updateError(`Could not save session: ${error.message}`);
    }
  }

  private loadSession() {
    try {
      const savedData = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (savedData) {
        const sessionData = JSON.parse(savedData);
        this.transcriptHistory = sessionData.transcriptHistory || [];
        this.selectedVoice = sessionData.selectedVoice || 'Zephyr';
        this.reinitSession();
        this.updateStatus('Session loaded successfully.');
      } else {
        this.updateStatus('No saved session found.');
      }
    } catch (error) {
      this.updateError(`Could not load session: ${error.message}`);
    }
  }

  private loadSessionOnStartup() {
    try {
      const savedData = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (savedData) {
        const sessionData = JSON.parse(savedData);
        this.transcriptHistory = sessionData.transcriptHistory || [];
        this.selectedVoice = sessionData.selectedVoice || 'Zephyr';
      }
    } catch (error) {
      console.error('Failed to load session on startup:', error);
      this.transcriptHistory = [];
      this.selectedVoice = 'Zephyr';
    }
  }

  render() {
    return html`
      <div class="main-container">
        <div id="transcript-container">
          ${this.transcriptHistory.map(
            (entry) => html`
              <div class="transcript-entry">
                <strong>${entry.speaker}:</strong> ${entry.text}
              </div>
            `,
          )}
          ${this.currentInputTranscription
            ? html`<div class="transcript-entry current-transcript">
                <strong>You:</strong> ${this.currentInputTranscription}
              </div>`
            : ''}
          ${this.currentOutputTranscription
            ? html`<div class="transcript-entry current-transcript">
                <strong>Gemini:</strong> ${this.currentOutputTranscription}
              </div>`
            : ''}
        </div>

        <div class="controls">
          <button
            id="micButton"
            class=${classMap({recording: this.isRecording})}
            @click=${this.toggleRecording}
            aria-label=${
              this.isRecording ? 'Stop recording' : 'Start recording'
            }
          >
            ${this.isRecording
              ? html`<svg
                  xmlns="http://www.w3.org/2000/svg"
                  height="24px"
                  viewBox="0 -960 960 960"
                  width="24px"
                  fill="#ffffff"
                >
                  <path d="M320-320v-320h320v320H320Z" />
                </svg>`
              : html`<svg
                  xmlns="http://www.w3.org/2000/svg"
                  height="24px"
                  viewBox="0 -960 960 960"
                  width="24px"
                  fill="#ffffff"
                >
                  <path
                    d="M480-400q-50 0-85-35t-35-85v-200q0-50 35-85t85-35q50 0 85 35t35 85v200q0 50-35 85t-85 35ZM280-80q-50-31-79-81t-29-105h80q0 50 29.5 90.5T341-121l-61 61Zm400 0-61-61q32-21 61.5-61.5T709-266h80q0 55-29 105t-79 81ZM440-800v-120h80v120h-80Zm40 680q83 0 141.5-58.5T680-320H280q0 83 58.5 141.5T480-120Z"
                  />
                </svg>`}
          </button>
          <button
            id="resetButton"
            @click=${this.reset}
            aria-label="Reset Session"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="24px"
              viewBox="0 -960 960 960"
              width="24px"
              fill="#ffffff"
            >
              <path
                d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z"
              />
            </svg>
          </button>
          <button
            id="saveButton"
            @click=${this.saveSession}
            aria-label="Save Session"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="24px"
              viewBox="0 -960 960 960"
              width="24px"
              fill="#ffffff"
            >
              <path
                d="M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm0-80h560v-560H200v560Zm200-200h160v-240H400v240Zm-80 80h320v-400H320v400Zm80-320Z"
              />
            </svg>
          </button>
          <button
            id="loadButton"
            @click=${this.loadSession}
            aria-label="Load Session"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="24px"
              viewBox="0 -960 960 960"
              width="24px"
              fill="#ffffff"
            >
              <path
                d="M200-160q-33 0-56.5-23.5T120-240v-480q0-33 23.5-56.5T200-800h240l80 80h280q33 0 56.5 23.5T880-640v400q0 33-23.5 56.5T800-160H200Zm0-80h600v-400H440l-80-80H200v480Zm0 0v-480 480Z"
              />
            </svg>
          </button>
          <select
            @change=${this.handleVoiceChange}
            .value=${this.selectedVoice}
            aria-label="Select AI Voice"
          >
            ${VOICES.map(
              (voice) => html`<option value=${voice}>${voice}</option>`,
            )}
          </select>
          <button
            id="exportButton"
            @click=${this.exportTranscript}
            aria-label="Export Transcript"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="24px"
              viewBox="0 -960 960 960"
              width="24px"
              fill="#ffffff"
            >
              <path
                d="M480-320 280-520l56-56 144 144v-448h80v448l144-144 56 56L480-320ZM240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0 33-23.5 56.5T720-160H240Z"
              />
            </svg>
          </button>
        </div>

        <div id="status"> ${this.error || this.status} </div>
        <gdm-live-audio-visuals-3d
          .inputNode=${this.inputNode}
          .outputNode=${this.outputNode}
        ></gdm-live-audio-visuals-3d>
      </div>
    `;
  }
}