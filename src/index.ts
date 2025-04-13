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

/**
 * @var isPlayingAudio
 * @description 現在音声が再生中かどうかを示すフラグ
 * @type {boolean}
 */
let isPlayingAudio = false;

/**
 * @var VOICEVOX_HOST
 * @description VOICEVOXエンジンのホスト
 * @type {string}
 */
const VOICEVOX_HOST: string = process.env.VOICEVOX_HOST || "127.0.0.1";

/**
 * @var VOICEVOX_PORT
 * @description VOICEVOXエンジンのポート
 * @type {string}
 */
const VOICEVOX_PORT: string = process.env.VOICEVOX_PORT || "50021";

/**
 * @var DEFAULT_SPEAKER
 * @description デフォルトの話者ID
 * @type {number}
 */
const DEFAULT_SPEAKER: number = parseInt(process.env.DEFAULT_SPEAKER || "3");

/**
 * @var VOLUME_SCALE
 * @description 音量調整スケール
 * @type {number}
 */
const VOLUME_SCALE: number = parseFloat(process.env.VOLUME_SCALE || "0.5");

/**
 * @var SPEED_SCALE
 * @description 再生速度調整スケール
 * @type {number}
 */
const SPEED_SCALE: number = parseFloat(process.env.SPEED_SCALE || "1.05");

/**
 * @var PRE_PHONEME_LENGTH
 * @description 音素前の長さ
 * @type {number}
 */
const PRE_PHONEME_LENGTH: number = parseFloat(process.env.PRE_PHONEME_LENGTH || "0.3");

/**
 * @var POST_PHONEME_LENGTH
 * @description 音素後の長さ
 * @type {number}
 */
const POST_PHONEME_LENGTH: number = parseFloat(process.env.POST_PHONEME_LENGTH || "0.3");

/**
 * @var INTONATION_SCALE
 * @description イントネーション調整スケール
 * @type {number}
 */
const INTONATION_SCALE: number = parseFloat(process.env.INTONATION_SCALE || "1.1");

/**
 * @var MAX_CHUNK_LENGTH
 * @description テキストチャンクの最大長
 * @type {number}
 */
const MAX_CHUNK_LENGTH: number = parseInt(process.env.MAX_CHUNK_LENGTH || "300");

/**
 * @var ENABLE_FFMPEG
 * @description FFMPEGを使用するかどうか
 * @type {boolean}
 */
const ENABLE_FFMPEG: boolean = process.env.ENABLE_FFMPEG === "true";

/**
 * @var NOISE_REDUCTION_LEVEL
 * @description ノイズ低減レベル
 * @type {number}
 */
const NOISE_REDUCTION_LEVEL: number = parseFloat(process.env.NOISE_REDUCTION_LEVEL || "0.15");

/**
 * @var HIGHPASS_FREQUENCY
 * @description ハイパスフィルターの周波数
 * @type {number}
 */
const HIGHPASS_FREQUENCY: number = parseInt(process.env.HIGHPASS_FREQUENCY || "100");

/**
 * @var LOWPASS_FREQUENCY
 * @description ローパスフィルターの周波数
 * @type {number}
 */
const LOWPASS_FREQUENCY: number = parseInt(process.env.LOWPASS_FREQUENCY || "8000");

/**
 * @interface SynthesisResult
 * @description 音声合成結果を表すインターフェース
 * @property {boolean} success - 合成が成功したかどうか
 * @property {string} [tempFile] - 生成された一時音声ファイルのパス
 */
interface SynthesisResult {
  success: boolean;
  tempFile?: string;
}

/**
 * @interface AudioResult
 * @description 音声処理結果を表すインターフェース
 * @property {boolean} success - 処理が成功したかどうか
 */
interface AudioResult {
  success: boolean;
}

/**
 * @interface DialogueData
 * @description 対話データを表すインターフェース
 * @property {string} text - 発話テキスト
 * @property {number} [speaker] - 話者ID
 */
interface DialogueData {
  text: string;
  speaker?: number;
}

/**
 * @interface VoicevoxQueryData
 * @description VOICEVOX APIに送信するクエリデータ
 * @property {number} volumeScale - 音量スケール
 * @property {number} speedScale - 速度スケール
 * @property {number} prePhonemeLength - 音素前の長さ
 * @property {number} postPhonemeLength - 音素後の長さ
 * @property {number} intonationScale - イントネーションスケール
 */
interface VoicevoxQueryData {
  volumeScale: number;
  speedScale: number;
  prePhonemeLength: number;
  postPhonemeLength: number;
  intonationScale: number;
  [key: string]: any;
}

/**
 * @interface Tool
 * @description MCPツール定義のインターフェース
 * @property {string} name - ツール名
 * @property {string} description - ツールの説明
 * @property {object} inputSchema - 入力スキーマ定義
 */
interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
}

/**
 * @var GET_SPEAKERS_TOOL
 * @description 話者一覧を取得するツール定義
 * @type {Tool}
 */
const GET_SPEAKERS_TOOL: Tool = {
  name: "get_speakers",
  description: 
    "Retrieves available speakers (characters) information from the VOICEVOX engine. " +
    "Includes each speaker's ID, name, style information, etc. " +
    "Used to select an appropriate speaker before voice synthesis.",
  inputSchema: {
    type: "object",
    properties: {}
  }
};

/**
 * @var SPEAK_TOOL
 * @description テキストを音声に変換して再生するツール定義
 * @type {Tool}
 */
const SPEAK_TOOL: Tool = {
  name: "speak",
  description: 
    "Converts text to speech and plays it back. " +
    "Supports speech by a single speaker or reading in conversation format with multiple speakers. " +
    "Each speaker has different voice qualities and characteristics that affect emotion expression and reading style. ",
  inputSchema: {
    type: "object",
    properties: {
      dialogues: {
        type: "array",
        description: "List of conversation dialogues (array of speaker ID and text pairs)",
        items: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "Text to be read aloud"
            },
            speaker: {
              type: "number",
              description: "Speaker ID (default: 3, Zundamon)"
            }
          },
          required: ["text"]
        }
      }
    },
    required: ["dialogues"]
  }
};

/**
 * @var STOP_SPEAK_TOOL
 * @description 音声再生を停止するツール定義
 * @type {Tool}
 */
const STOP_SPEAK_TOOL: Tool = {
  name: "stop_speak",
  description: 
    "Stops currently playing audio. " +
    "Used to interrupt playback in the middle.",
  inputSchema: {
    type: "object",
    properties: {}
  }
};

/**
 * @function loadFfmpeg
 * @description FFMPEGモジュールを読み込む
 * @returns {Promise<typeof ffmpegType | null>} ffmpegモジュールのインスタンス、またはロードに失敗した場合はnull
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
 * @function splitTextIntoSentences
 * @description テキストを文章に分割する
 * @param {string} text - 分割する元のテキスト
 * @returns {string[]} 分割された文章の配列
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
 * @function applyAudioFilters
 * @description オーディオファイルにフィルターを適用する
 * @param {string} inputFile - 処理する入力ファイルのパス
 * @returns {Promise<string>} 処理後のファイルパス
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
 * @function synthesizeSentence
 * @description 文章を音声に変換する
 * @param {string} text - 変換するテキスト
 * @param {number} [speaker=DEFAULT_SPEAKER] - 話者ID
 * @returns {Promise<SynthesisResult>} 音声合成結果
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
 * @function updatePlayState
 * @description 再生状態を更新する
 * @param {boolean} isPlaying - 再生中かどうか
 * @returns {void}
 */
function updatePlayState(isPlaying: boolean): void {
  isPlayingAudio = isPlaying;
}

/**
 * @function checkPlayState
 * @description 再生状態を確認する
 * @returns {boolean} 現在再生中かどうか
 */
function checkPlayState(): boolean {
  return isPlayingAudio;
}

/**
 * @class AudioPlayer
 * @description 音声再生を管理するクラス
 * @property {boolean} initialized - 初期化済みかどうか
 * @property {string} platform - 実行プラットフォーム
 * @property {DialogueData[][]} queue - 音声再生キュー
 * @property {boolean} isProcessing - 現在処理中かどうか
 */
class AudioPlayer {
  private initialized: boolean;
  private platform: string;
  private queue: DialogueData[][] = [];
  private isProcessing: boolean = false;

  /**
   * @constructor
   * @description オーディオプレーヤーを作成する
   */
  constructor() {
    this.initialized = false;
    this.platform = process.platform;
  }

  /**
   * @method initialize
   * @description オーディオプレーヤーを初期化する
   * @returns {Promise<void>}
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    
    updatePlayState(false);
  }

  /**
   * @method addToQueue
   * @description 音声再生キューにダイアログを追加する
   * @param {DialogueData[]} dialogues - 追加するダイアログデータの配列
   * @returns {Promise<void>}
   */
  async addToQueue(dialogues: DialogueData[]): Promise<void> {
    this.queue.push(dialogues);
    if (!this.isProcessing) {
      this.processQueue();
    }
  }

  /**
   * @method processQueue
   * @description キューを処理する
   * @private
   * @returns {Promise<void>}
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
   * @method stopAudio
   * @description 音声再生を停止する
   * @returns {Promise<boolean>} 停止が成功したかどうか
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
   * @method playAudio
   * @description オーディオファイルを再生する
   * @param {string} tempFile - 再生する一時ファイルのパス
   * @returns {Promise<AudioResult>} 再生結果
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
 * @var audioPlayer
 * @description オーディオプレーヤーのインスタンス
 * @type {AudioPlayer}
 */
const audioPlayer = new AudioPlayer();

/**
 * @function playAudioFile
 * @description 音声ファイルを再生する
 * @param {string} tempFile - 再生する一時ファイルのパス
 * @returns {Promise<AudioResult>} 再生結果
 */
async function playAudioFile(tempFile: string): Promise<AudioResult> {
  return await audioPlayer.playAudio(tempFile);
}

/**
 * @function textToSpeech
 * @description テキストを音声に変換して再生する
 * @param {string} text - 読み上げるテキスト
 * @param {number} [speaker=DEFAULT_SPEAKER] - 話者ID
 * @returns {Promise<AudioResult>} 音声処理結果
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
 * @function conversationToSpeech
 * @description 会話形式のテキストを音声に変換して再生する
 * @param {DialogueData[]} dialogues - 発話データの配列
 * @returns {Promise<AudioResult>} 音声処理結果
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
 * @function processChunksParallel
 * @description テキストチャンクを並列処理して音声に変換して再生する
 * @param {string[]} chunks - 処理するテキストチャンクの配列
 * @param {number} speaker - 話者ID
 * @returns {Promise<AudioResult>} 音声処理結果
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
 * @function main
 * @description MCPサーバーを初期化して起動する
 * @returns {Promise<void>}
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
      description: "Converts text to speech using VOICEVOX"
    });

    /**
     * @function get_speakers
     * @description 話者一覧を取得するツール
     * @returns {Promise<{content: Array<{type: string, text: string}>}>} 話者情報またはエラーメッセージ
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
            content: [{ type: "text", text: "Error: Failed to retrieve speaker information" }]
          };
        }
      }
    );

    /**
     * @function speak
     * @description テキストを音声に変換して再生するツール
     * @param {Object} options - 入力オプション
     * @param {DialogueData[]} options.dialogues - 会話データの配列
     * @returns {Promise<{content: Array<{type: string, text: string}>}>} 処理結果メッセージ
     */
    server.tool(
      SPEAK_TOOL.name,
      SPEAK_TOOL.description,
      {
        dialogues: z.array(
          z.object({
            text: z.string().describe("Text to be read aloud"),
            speaker: z.number().optional().describe("Speaker ID (default: 3, Zundamon)")
          })
        ).describe("List of conversation dialogues (array of speaker ID and text pairs)")
      },
      async ({ dialogues }) => {
        try {
          if (!Array.isArray(dialogues) || dialogues.length === 0) {
            return {
              content: [{ type: "text", text: "Error: No valid conversation data provided" }]
            };
          }

          const typedDialogues: DialogueData[] = dialogues.map(dialogue => ({
            text: dialogue.text,
            speaker: dialogue.speaker
          }));

          audioPlayer.addToQueue(typedDialogues);
          
          let message = "Started reading the conversation";
          
          if (ENABLE_FFMPEG) {
            const ffmpeg = await loadFfmpeg();
            if (ffmpeg) {
              message += " (audio filters applied)";
            }
          }
          
          return {
            content: [{ type: "text", text: message }]
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: "Failed to start voice synthesis" }]
          };
        }
      }
    );

    /**
     * @function stop_speak
     * @description 音声再生を停止するツール
     * @returns {Promise<{content: Array<{type: string, text: string}>}>} 停止処理結果メッセージ
     */
    server.tool(
      STOP_SPEAK_TOOL.name,
      STOP_SPEAK_TOOL.description,
      {},
      async () => {
        const result = await audioPlayer.stopAudio();
        return {
          content: [{ 
            type: "text", 
            text: result ? "Stopped audio playback" : "Failed to stop audio playback" 
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