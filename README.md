# MCP VOICEVOX Server

VOICEVOXエンジンを利用して、AIエージェントに音声を読み上げさせるMCP（Model Context Protocol）サーバーです。

※本プロジェクトは非公式の個人開発であり、VOICEVOX公式の開発プロジェクトとは無関係です。

VOICEVOX公式サイト: https://voicevox.hiroshiba.jp/

## 機能

- VOICEVOXエンジンを使用したテキスト音声変換
- キャラクターの指定
- 掛け合い形式の読み上げ
- 音声パラメータ調整
- 長い文章に対応する逐次処理
- FFmpegによるノイズ除去（オプション）

## AIエージェントが使用できるツール

### get_speakers
- **説明**: VOICEVOXエンジンの利用可能な話者（キャラクター）情報を取得します
- **入力パラメータ**: なし
- **出力**: 話者情報の一覧（JSON形式）

### speak
- **説明**: テキストを音声に変換して再生します
- **入力パラメータ**: 
  - `dialogues`: 会話形式のダイアログリスト（テキストと話者IDのペアの配列）
    - `text`: テキスト（必須）
    - `speaker`: 話者ID（省略可、デフォルト: 3, ずんだもん）
- **出力**: 読み上げ開始のメッセージ

### stop_speak
- **説明**: 現在再生中の音声を停止します
- **入力パラメータ**: なし
- **出力**: 音声停止の結果メッセージ

## 動作環境
- Node.js v22.14.0
- VOICEVOX（0.23.0 で動作確認済み）
- FFmpeg（ノイズ除去を使用する場合のみ）

※音声再生にOSの機能を利用しており、Windows 11以外での動作は検証していません（対応予定なし）

## 依存関係のインストール

```
npm install
```
- 別途、VOICEVOXをインストールしてください
- オプションのノイズ除去機能を使用するためには、FFmpegをインストールしておく必要があります

https://www.ffmpeg.org/download.html
## ビルド

```
npm run build
```

## 起動方法

- VOICEVOXエンジンをGUIやDockerで起動しておく必要があります
- このMCP Serverをあらかじめ起動する必要はありません

## 環境変数

環境変数はすべてオプションです。設定されていない場合はデフォルト値が使用されます。

| 環境変数 | 説明 | デフォルト値 |
|----------|------|-------------|
| VOICEVOX_HOST | VOICEVOXサーバーのホスト名 | 127.0.0.1 |
| VOICEVOX_PORT | VOICEVOXサーバーのポート番号 | 50021 |
| DEFAULT_SPEAKER | デフォルトの話者ID | 3 (ずんだもん) |
| VOLUME_SCALE | 音量 | 0.5 |
| SPEED_SCALE | 再生速度 | 1.05 |
| PRE_PHONEME_LENGTH | 音声の前のポーズの長さ | 0.3 |
| POST_PHONEME_LENGTH | 音声の後のポーズの長さ | 0.3 |
| INTONATION_SCALE | イントネーションのスケール | 1.1 |
| MAX_CHUNK_LENGTH | 最大チャンク長（テキスト分割用） | 300 |
| ENABLE_FFMPEG | FFmpegを有効にするかどうか | false |
| NOISE_REDUCTION_LEVEL | ノイズ低減レベル | 0.15 |
| HIGHPASS_FREQUENCY | ハイパスフィルター周波数 | 100 |
| LOWPASS_FREQUENCY | ローパスフィルター周波数 | 8000 |
| FFMPEG_PATH | FFmpegの実行ファイルパス | システムのPATHから検索 |

## configの記述例
```
{
  "mcpServers": {
    "voicevox": {
      "command": "node",
      "args": [
        "プロジェクトのルート\\dist\\index.js"
      ],
      "env": {
        "VOLUME_SCALE": "0.25",
        "INTONATION_SCALE": "1.2",
      }
    }
  }
}
```
## 推奨システムプロンプト
```
プログラムのソースコードなど、自然言語ではないテキストは音声で読み上げないでください。テキストが長文になるときは、400字程度で分割して読み上げてください。
```


## プロンプト例
```
ずんだもんと四国めたんのストーリーを創作し、読み上げてください
```
```
音声を止めてください
```

## 開発

このプロジェクトはTypeScriptで実装されています。開発時は以下のコマンドで自動コンパイルが可能です：

```
npm run dev
```

## ライセンス

MIT License

## 免責事項
本プロジェクトの利用により生じた損害・不利益について、製作者は一切の責任を負いません。