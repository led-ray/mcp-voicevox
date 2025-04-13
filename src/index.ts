#!/usr/bin/env node

/**
 * @fileoverview VOICEVOXを使用してテキストを音声に変換するMCPサーバー
 * @module voicevox-mcp
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import * as fs from "fs";
import { exec } from "child_process";
import * as path from "path";
import * as os from "os";
import type { default as ffmpegType } from "fluent-ffmpeg";

let isPlayingAudio = false;

const VOICEVOX_HOST: string = process.env.VOICEVOX_HOST || "127.0.0.1";
const VOICEVOX_PORT: string = process.env.VOICEVOX_PORT || "50021";
const DEFAULT_SPEAKER: number = parseInt(process.env.DEFAULT_SPEAKER || "3");
const VOLUME_SCALE: number = parseFloat(process.env.VOLUME_SCALE || "0.5");
const SPEED_SCALE: number = parseFloat(process.env.SPEED_SCALE || "1.05");
const PRE_PHONEME_LENGTH: number = parseFloat(process.env.PRE_PHONEME_LENGTH || "0.3");
const POST_PHONEME_LENGTH: number = parseFloat(process.env.POST_PHONEME_LENGTH || "0.3");
const INTONATION_SCALE: number = parseFloat(process.env.INTONATION_SCALE || "1.1");
const MAX_CHUNK_LENGTH: number = parseInt(process.env.MAX_CHUNK_LENGTH || "300");
const ENABLE_FFMPEG: boolean = process.env.ENABLE_FFMPEG === "true";
const NOISE_REDUCTION_LEVEL: number = parseFloat(process.env.NOISE_REDUCTION_LEVEL || "0.15");
const HIGHPASS_FREQUENCY: number = parseInt(process.env.HIGHPASS_FREQUENCY || "100");
const LOWPASS_FREQUENCY: number = parseInt(process.env.LOWPASS_FREQUENCY || "8000");

interface SynthesisResult {
  success: boolean;
  tempFile?: string;
}

interface AudioResult {
  success: boolean;
}

interface DialogueData {
  text: string;
  speaker?: number;
}

interface VoicevoxQueryData {
  volumeScale: number;
  speedScale: number;
  prePhonemeLength: number;
  postPhonemeLength: number;
  intonationScale: number;
  pitchScale?: number;
  [key: string]: any;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
}

const GET_SPEAKERS_TOOL: Tool = {
  name: "get_speakers",
  description: 
    "VOICEVOXエンジンの利用可能な話者（キャラクター）情報を取得します。" +
    "各話者のID、名前、スタイル情報などが含まれます。" +
    "音声合成前に適切な話者を選択するために使用します。",
  inputSchema: {
    type: "object",
    properties: {}
  }
};

const SPEAK_TOOL: Tool = {
  name: "speak",
  description: 
    "テキストを音声に変換して再生します。" +
    "単一話者による発話や、複数話者による会話形式の読み上げに対応しています。" +
    "各話者には異なる声質や特性があり、感情表現や読み方に影響します。" +
    "長いテキストは自動的に分割されて適切なタイミングで再生されます。" +
    "音声処理機能が有効な場合は、より聞き取りやすい音質に調整されます。",
  inputSchema: {
    type: "object",
    properties: {
      dialogues: {
        type: "array",
        description: "会話形式のダイアログリスト（話者IDとテキストのペアの配列）",
        items: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "読み上げるテキスト"
            },
            speaker: {
              type: "number",
              description: "話者ID（デフォルト: 3, ずんだもん）"
            }
          },
          required: ["text"]
        }
      }
    },
    required: ["dialogues"]
  }
};

const STOP_SPEAK_TOOL: Tool = {
  name: "stop_speak",
  description: 
    "現在再生中の音声を停止します。" +
    "読み上げを途中で中断する場合に使用します。",
  inputSchema: {
    type: "object",
    properties: {}
  }
};

/**
 * FFMPEGモジュールを読み込む
 */
async function loadFfmpeg(): Promise<typeof ffmpegType | null> {
  if (!ENABLE_FFMPEG) return null;
  
  try {
    const ffmpegModule = await import('fluent-ffmpeg');
    const ffmpeg = ffmpegModule.default;
    
    if (process.env.FFMPEG_PATH) {
      ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
    }
    
    return ffmpeg;
  } catch (error) {
    return null;
  }
}

/**
 * テキストを文章に分割する
 */
function splitTextIntoSentences(text: string): string[] {
  const sentences = text
    .split(/(?<=[。.])/g)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length > 0);
  
  if (sentences.length === 0 && text.trim().length > 0) {
    return [text.trim()];
  }
  
  return sentences;
}

/**
 * オーディオファイルにフィルターを適用する
 */
async function applyAudioFilters(inputFile: string): Promise<string> {
  if (!ENABLE_FFMPEG) return inputFile;
  
  try {
    const ffmpeg = await loadFfmpeg();
    if (!ffmpeg) return inputFile;
    
    const outputFile = path.join(
      os.tmpdir(), 
      "voicevox_processed_" + Date.now() + ".wav"
    );
    
    return new Promise<string>((resolve, reject) => {
      let command = ffmpeg(inputFile);
      
      command = command.audioFilters("highpass=f=" + HIGHPASS_FREQUENCY);
      command = command.audioFilters("lowpass=f=" + LOWPASS_FREQUENCY);
      command = command.audioFilters("afftdn=nr=" + NOISE_REDUCTION_LEVEL + ":nf=-25");
      
      command
        .audioCodec('pcm_s16le')
        .audioFrequency(44100)
        .format('wav')
        .output(outputFile)
        .on('end', () => {
          fs.unlinkSync(inputFile);
          resolve(outputFile);
        })
        .on('error', () => {
          resolve(inputFile);
        })
        .run();
    });
  } catch (error) {
    return inputFile;
  }
}

/**
 * 文章を音声に変換する
 */
async function synthesizeSentence(text: string, speaker: number = DEFAULT_SPEAKER): Promise<SynthesisResult> {
  try {
    const queryUrl = "http://" + VOICEVOX_HOST + ":" + VOICEVOX_PORT + "/audio_query";
    const queryResponse = await axios.post(queryUrl, null, {
      params: { text, speaker },
    });
    
    const queryData: VoicevoxQueryData = queryResponse.data;

    queryData.volumeScale = VOLUME_SCALE;
    queryData.speedScale = SPEED_SCALE;
    queryData.prePhonemeLength = PRE_PHONEME_LENGTH; 
    queryData.postPhonemeLength = POST_PHONEME_LENGTH;
    queryData.intonationScale = INTONATION_SCALE;

    const synthesisUrl = "http://" + VOICEVOX_HOST + ":" + VOICEVOX_PORT + "/synthesis";
    const synthesisResponse = await axios.post(
      synthesisUrl,
      queryData,
      {
        params: { speaker },
        responseType: "arraybuffer",
        headers: { "Content-Type": "application/json" },
      }
    );
    
    const tempFile = path.join(os.tmpdir(), "voicevox_" + Date.now() + ".wav");
    fs.writeFileSync(tempFile, Buffer.from(synthesisResponse.data));
    
    let finalFile = tempFile;
    if (ENABLE_FFMPEG) {
      finalFile = await applyAudioFilters(tempFile);
    }
    
    return { success: true, tempFile: finalFile };
  } catch (error) {
    return { success: false };
  }
}

/**
 * 再生状態を更新する
 */
function updatePlayState(isPlaying: boolean): void {
  isPlayingAudio = isPlaying;
}

/**
 * 再生状態を確認する
 */
function checkPlayState(): boolean {
  return isPlayingAudio;
}

/**
 * オーディオプレーヤークラス
 */
class AudioPlayer {
  private initialized: boolean;
  private platform: string;
  private queue: DialogueData[][] = [];
  private isProcessing: boolean = false;

  /**
   * オーディオプレーヤーを作成する
   */
  constructor() {
    this.initialized = false;
    this.platform = process.platform;
  }

  /**
   * オーディオプレーヤーを初期化する
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    
    updatePlayState(false);
  }

  /**
   * 音声再生キューにダイアログを追加する
   */
  async addToQueue(dialogues: DialogueData[]): Promise<void> {
    this.queue.push(dialogues);
    if (!this.isProcessing) {
      this.processQueue();
    }
  }

  /**
   * キューを処理する
   */
  private async processQueue(): Promise<void> {
    if (this.queue.length === 0) {
      this.isProcessing = false;
      return;
    }

    this.isProcessing = true;
    const currentDialogues = this.queue[0];
    this.queue.shift();

    try {
      await conversationToSpeech(currentDialogues);
    } catch (error) {
      console.error("キュー処理中にエラーが発生しました:", error);
    }

    this.processQueue();
  }

  /**
   * 音声再生を停止する
   */
  async stopAudio(): Promise<boolean> {
    try {
      updatePlayState(false);
      
      this.queue = [];
      
      if (this.platform === "win32") {
        exec('taskkill /F /IM powershell.exe /FI "WINDOWTITLE eq Windows PowerShell"', () => {});
      } else if (this.platform === "darwin") {
        exec('pkill afplay', () => {});
      } else {
        exec('pkill aplay', () => {});
      }
      
      return true;
    } catch (error) {
      console.error("音声停止に失敗しました:", error);
      return false;
    }
  }

  /**
   * オーディオファイルを再生する
   */
  async playAudio(tempFile: string): Promise<AudioResult> {
    try {
      if (!this.initialized) {
        await this.initialize();
      }
      
      if (!checkPlayState()) {
        fs.unlinkSync(tempFile);
        return { success: false };
      }
      
      let playCommand: string;
      if (this.platform === "win32") {
        playCommand = "powershell -c \"(New-Object Media.SoundPlayer '" + tempFile + "').PlaySync()\"";
      } else if (this.platform === "darwin") {
        playCommand = "afplay '" + tempFile + "'";
      } else {
        playCommand = "aplay '" + tempFile + "'";
      }
      
      await new Promise<void>((resolve, reject) => {
        exec(playCommand, (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
      
      fs.unlinkSync(tempFile);
      
      return { success: true };
    } catch (error) {
      return { success: false };
    }
  }
}

/**
 * オーディオプレーヤーのインスタンス
 */
const audioPlayer = new AudioPlayer();

/**
 * オーディオファイルを再生する
 */
async function playAudioFile(tempFile: string): Promise<AudioResult> {
  return await audioPlayer.playAudio(tempFile);
}

/**
 * テキストを音声に変換して再生する
 */
async function textToSpeech(text: string, speaker: number = DEFAULT_SPEAKER): Promise<AudioResult> {
  try {
    const sentences = splitTextIntoSentences(text);
    
    const allChunks: string[] = [];
    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      
      if (sentence.length > MAX_CHUNK_LENGTH) {
        let remainingText = sentence;
        
        while (remainingText.length > 0) {
          let chunkEnd = Math.min(remainingText.length, MAX_CHUNK_LENGTH);
          for (let j = chunkEnd; j > MAX_CHUNK_LENGTH / 2; j--) {
            const char = remainingText.charAt(j - 1);
            if (char === '。') {
              chunkEnd = j;
              break;
            }
          }
          
          allChunks.push(remainingText.substring(0, chunkEnd));
          remainingText = remainingText.substring(chunkEnd);
        }
      } else {
        allChunks.push(sentence);
      }
    }
    
    return await processChunksParallel(allChunks, speaker);
  } catch (error) {
    return { success: false };
  }
}

/**
 * 会話形式のテキストを音声に変換して再生する
 */
async function conversationToSpeech(dialogues: DialogueData[]): Promise<AudioResult> {
  try {
    updatePlayState(true);
    
    for (let i = 0; i < dialogues.length; i++) {
      if (!checkPlayState()) {
        return { success: false };
      }
      
      const dialogue = dialogues[i];
      const { text, speaker = DEFAULT_SPEAKER } = dialogue;
      
      const result = await textToSpeech(text, speaker);
      
      if (!result.success) {
        updatePlayState(false);
        return { success: false };
      }
    }
    
    updatePlayState(false);
    return { success: true };
  } catch (error) {
    updatePlayState(false);
    return { success: false };
  }
}

/**
 * テキストチャンクを並列処理して音声に変換して再生する
 */
async function processChunksParallel(chunks: string[], speaker: number): Promise<AudioResult> {
  if (chunks.length === 0) {
    return { success: true };
  }
  
  const MAX_PARALLEL = 3;
  let hasError = false;
  
  let currentSynthResult = await synthesizeSentence(chunks[0], speaker);
  if (!currentSynthResult.success || !currentSynthResult.tempFile) {
    return { success: false };
  }
  
  const preloadPromises: Promise<SynthesisResult>[] = [];
  for (let i = 1; i < Math.min(chunks.length, MAX_PARALLEL); i++) {
    preloadPromises.push(synthesizeSentence(chunks[i], speaker));
  }
  
  const preloadedResults: SynthesisResult[] = [];
  
  if (preloadPromises.length > 0) {
    try {
      const results = await Promise.allSettled(preloadPromises);
      results.forEach(result => {
        if (result.status === 'fulfilled' && result.value.success) {
          preloadedResults.push(result.value);
        } else {
          hasError = true;
        }
      });
    } catch (error) {
      console.error("事前生成エラー:", error);
    }
  }
  
  let playResult = await playAudioFile(currentSynthResult.tempFile);
  if (!playResult.success) {
    hasError = true;
  }
  
  let currentIndex = 1;
  
  for (const preloadedResult of preloadedResults) {
    if (!checkPlayState() || !preloadedResult.tempFile) break;
    
    const nextIndex = currentIndex + preloadedResults.length;
    let nextSynthesisPromise: Promise<SynthesisResult | null> = Promise.resolve(null);
    if (nextIndex < chunks.length) {
      nextSynthesisPromise = synthesizeSentence(chunks[nextIndex], speaker);
    }
    
    playResult = await playAudioFile(preloadedResult.tempFile);
    if (!playResult.success) {
      hasError = true;
    }
    
    currentIndex++;
    
    const nextSynthResult = await nextSynthesisPromise;
    if (nextSynthResult && nextSynthResult.success && nextSynthResult.tempFile) {
      preloadedResults.push(nextSynthResult);
    }
  }
  
  while (currentIndex + preloadedResults.length < chunks.length) {
    if (!checkPlayState()) break;
    
    const nextIndex = currentIndex + preloadedResults.length;
    const synthResult = await synthesizeSentence(chunks[nextIndex], speaker);
    
    if (!checkPlayState()) break;
    
    if (!synthResult.success || !synthResult.tempFile) {
      hasError = true;
      currentIndex++;
      continue;
    }
    
    playResult = await playAudioFile(synthResult.tempFile);
    if (!playResult.success) {
      hasError = true;
    }
    
    currentIndex++;
  }
  
  return { success: !hasError };
}

/**
 * メイン関数
 */
async function main(): Promise<void> {
  try {
    if (ENABLE_FFMPEG) {
      await loadFfmpeg();
    }
    
    await audioPlayer.initialize();

    const server = new McpServer({
      name: "voicevox",
      version: "1.0.0",
      description: "VOICEVOXを使用してテキストを音声に変換します"
    });

    /**
     * 話者一覧を取得するツール
     */
    server.tool(
      GET_SPEAKERS_TOOL.name,
      {},
      async () => {
        try {
          const response = await axios.get("http://" + VOICEVOX_HOST + ":" + VOICEVOX_PORT + "/speakers");
          return {
            content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }]
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: "エラー: 話者情報の取得に失敗しました" }]
          };
        }
      }
    );

    /**
     * テキストを音声に変換して再生するツール
     */
    server.tool(
      SPEAK_TOOL.name,
      {
        dialogues: z.array(
          z.object({
            text: z.string().describe("読み上げるテキスト"),
            speaker: z.number().optional().describe("話者ID（デフォルト: 3, ずんだもん）")
          })
        ).describe("会話形式のダイアログリスト（話者IDとテキストのペアの配列）")
      },
      async ({ dialogues }) => {
        try {
          if (!Array.isArray(dialogues) || dialogues.length === 0) {
            return {
              content: [{ type: "text", text: "エラー: 有効な会話データが提供されていません" }]
            };
          }

          const typedDialogues: DialogueData[] = dialogues.map(dialogue => ({
            text: dialogue.text,
            speaker: dialogue.speaker
          }));

          audioPlayer.addToQueue(typedDialogues);
          
          let message = "会話の読み上げを開始しました";
          
          if (ENABLE_FFMPEG) {
            const ffmpeg = await loadFfmpeg();
            if (ffmpeg) {
              message += "（オーディオフィルター適用）";
            }
          }
          
          return {
            content: [{ type: "text", text: message }]
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: "音声合成の開始に失敗しました" }]
          };
        }
      }
    );

    /**
     * 音声再生を停止するツール
     */
    server.tool(
      STOP_SPEAK_TOOL.name,
      {},
      async () => {
        const result = await audioPlayer.stopAudio();
        return {
          content: [{ 
            type: "text", 
            text: result ? "音声再生を停止しました" : "音声再生の停止に失敗しました" 
          }]
        };
      }
    );

    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (error) {
    process.exit(1);
  }
}

main(); 