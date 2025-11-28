import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { createAudioBlob, decodeBase64, decodeAudioData, blobToBase64 } from '../utils/audioUtils';

const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-09-2025';

export class GeminiLiveService {
  private client: GoogleGenAI;
  private sessionPromise: Promise<any> | null = null;
  private audioContext: AudioContext;
  private inputAudioContext: AudioContext;
  private nextStartTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private outputNode: GainNode;
  
  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
    this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    this.inputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
    this.outputNode = this.audioContext.createGain();
    this.outputNode.connect(this.audioContext.destination);
    this.outputNode.gain.value = 1.0; // Volume
  }

  public async connect(
    onMessage: (text: string) => void,
    onStatusChange: (status: 'connected' | 'error' | 'closed') => void
  ) {
    const config = {
      model: MODEL_NAME,
      callbacks: {
        onopen: () => {
          console.log('Gemini Live Connected');
          onStatusChange('connected');
          this.startAudioInput();
        },
        onmessage: async (message: LiveServerMessage) => {
          const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
          
          if (base64Audio) {
            this.playAudio(base64Audio);
          }
          
          if (message.serverContent?.turnComplete) {
            // Can handle turn completion logic here
          }
        },
        onclose: () => {
          console.log('Gemini Live Closed');
          onStatusChange('closed');
        },
        onerror: (err: any) => {
          console.error('Gemini Live Error', err);
          onStatusChange('error');
        }
      },
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } },
        },
        systemInstruction: `You are a high-energy, sarcastic, and funny e-sports commentator for a game of 'Hand Snake'. 
        The user plays Snake by waving their hand in front of the camera.
        
        Rules for you:
        1. Watch the video stream.
        2. Cheer when they get an apple (red square).
        3. Scream dramatically if they are about to hit a wall or themselves.
        4. Mock their hand gestures if they look silly.
        5. Keep your responses short, punchy, and reactive.
        6. Occasionally give 'pro tips' that are actually just basic snake advice.
        
        The game looks like a neon grid. The snake is green/cyan. The food is red.`,
      },
    };

    try {
      this.sessionPromise = this.client.live.connect(config);
      await this.sessionPromise;
    } catch (e) {
      console.error("Connection failed", e);
      onStatusChange('error');
    }
  }

  private async startAudioInput() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const source = this.inputAudioContext.createMediaStreamSource(stream);
      const processor = this.inputAudioContext.createScriptProcessor(4096, 1, 1);
      
      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        const pcmBlob = createAudioBlob(inputData);
        
        if (this.sessionPromise) {
          this.sessionPromise.then(session => {
            session.sendRealtimeInput({ media: pcmBlob });
          });
        }
      };
      
      source.connect(processor);
      processor.connect(this.inputAudioContext.destination);
    } catch (e) {
      console.error("Mic access denied", e);
    }
  }

  public async sendVideoFrame(base64Image: string) {
    if (!this.sessionPromise) return;
    
    // We send base64 raw JPEG data
    this.sessionPromise.then(session => {
        session.sendRealtimeInput({
            media: {
                mimeType: 'image/jpeg',
                data: base64Image
            }
        });
    });
  }

  private async playAudio(base64String: string) {
    const audioData = decodeBase64(base64String);
    this.nextStartTime = Math.max(this.nextStartTime, this.audioContext.currentTime);
    
    const audioBuffer = await decodeAudioData(
      audioData,
      this.audioContext,
      24000
    );
    
    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.outputNode);
    source.addEventListener('ended', () => {
      this.sources.delete(source);
    });
    
    source.start(this.nextStartTime);
    this.nextStartTime += audioBuffer.duration;
    this.sources.add(source);
  }

  public async disconnect() {
     // Currently no clean disconnect method exposed in the helper, 
     // but we can stop sending data and close contexts.
     // This is a placeholder for cleanup logic.
     this.inputAudioContext.close();
     this.audioContext.close();
  }
}