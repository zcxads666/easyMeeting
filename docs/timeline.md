# Transcript Timeline

easyMeeting 的时间数据只有一个 canonical source：`meeting.timeline`。ASR 原始 segments、Forced Alignment、speaker attribution、播放器和字幕都围绕它更新，不维护互相漂移的字幕副本。

```text
ASR transcript
  + meeting audio
        ↓
Forced Alignment (optional, model-agnostic)
        ↓
aligned words → canonical segments
        +
exclusive speaker turns (optional)
        ↓
speaker-attributed canonical timeline
        ↓
audio seek / active highlight / SRT / VTT
```

## Precision

- `aligned`: Qwen3 Forced Aligner 的词级 seconds。
- `native`: Provider/ASR 模型直接返回的 seconds。
- `estimated`: 基于真实 PCM audio window 的粗粒度边界。
- `unknown`: 没有可靠时间；`start/end` 必须为 `null`。

SRT/VTT 默认接受 aligned/native。estimated 需要调用方明确允许且响应会标记 warning；unknown 不会被转成虚假的 cue。

## Staleness

Alignment 保存 transcript source、SHA-256 text hash、audio identity、language、model 和 created time。Transcript change 会令 alignment 与 speaker attribution stale；audio change 还会令 diarization stale。Speaker label rename 只修改 `speakerLabels` mapping，不改变 timing 或 raw cluster ID。

Meeting schema v3 会在读取时将 v1 millisecond segments 与 v2 second segments安全迁移到内存结构，不批量覆盖旧会议文件。Settings schema v4 adds alignment、diarization、post-processing 和 requested realtime mode。

## Realtime

Transformers Qwen 与 faster-whisper 使用 chunked near-realtime，window timestamp 标记 estimated。可选 qwen-asr/vLLM backend 在支持环境提供真实 partial，但官方 streaming result 没有 timestamp，因此 live final 保持 unknown。停止会议后持久化 WAV 可再运行 alignment/diarization 生成 final timeline。
