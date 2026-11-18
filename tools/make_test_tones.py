#!/usr/bin/env python3
"""生成用于验收 / 手动测试的标准音 WAV（48 kHz、单声道、16-bit）

用法：
    python tools/make_test_tones.py

输出到 tests/fixtures/：
    c4.wav d4.wav e4.wav g4.wav a4.wav   5 秒标准正弦音（A4 = 440 Hz）
    a4_quiet.wav                         5 秒低电平 A4（约 −52 dBFS，用于验证低声唱歌门限）
    silence.wav                          2 秒静音
    noise.wav                            3 秒宽带噪声（用于验证“信号不足/低置信度”）

播放方式：用系统播放器循环播放，麦克风靠近扬声器即可在界面里看到对应音名。
"""

import array
import math
import random
import wave
from pathlib import Path

SAMPLE_RATE = 48000
BITS = 16
OUT_DIR = Path(__file__).resolve().parent.parent / "tests" / "fixtures"

# 十二平均律，A4 = 440 Hz
A4 = 440.0
NOTES = {
    "c4": 60,
    "d4": 62,
    "e4": 64,
    "g4": 67,
    "a4": 69,
}


def midi_to_freq(midi: int) -> float:
    return A4 * (2.0 ** ((midi - 69) / 12.0))


def fade(index: int, total: int, fade_samples: int) -> float:
    if index < fade_samples:
        return index / fade_samples
    if index >= total - fade_samples:
        return max(0.0, (total - index - 1) / fade_samples)
    return 1.0


def write_wav(path: Path, samples: array.array) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(BITS // 8)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(samples.tobytes())


def sine_tone(freq: float, seconds: float, amplitude: float) -> array.array:
    total = int(SAMPLE_RATE * seconds)
    fade_samples = int(SAMPLE_RATE * 0.02)
    data = array.array("h")
    for i in range(total):
        envelope = fade(i, total, fade_samples)
        value = amplitude * envelope * math.sin(2.0 * math.pi * freq * i / SAMPLE_RATE)
        data.append(int(max(-1.0, min(1.0, value)) * 32767))
    return data


def silence(seconds: float) -> array.array:
    return array.array("h", [0] * int(SAMPLE_RATE * seconds))


def noise(seconds: float, amplitude: float) -> array.array:
    total = int(SAMPLE_RATE * seconds)
    rng = random.Random(20261118)
    data = array.array("h")
    previous = 0.0
    for i in range(total):
        # 一阶低通，让噪声更接近房间底噪而不是纯白噪声
        white = rng.uniform(-1.0, 1.0)
        previous = previous * 0.72 + white * 0.28
        value = previous * amplitude * fade(i, total, int(SAMPLE_RATE * 0.02))
        data.append(int(max(-1.0, min(1.0, value)) * 32767))
    return data


def rms_dbfs(samples: array.array) -> float:
    if not samples:
        return float("-inf")
    power = sum((s / 32768.0) ** 2 for s in samples) / len(samples)
    return 10.0 * math.log10(max(power, 1e-12))


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print()
    print("生成标准音测试文件 →", OUT_DIR)
    print()
    print("  文件            目标音    频率 Hz      RMS dBFS")

    for name, midi in NOTES.items():
        freq = midi_to_freq(midi)
        samples = sine_tone(freq, 5.0, 0.30)
        path = OUT_DIR / f"{name}.wav"
        write_wav(path, samples)
        print(f"  {name + '.wav':<15} {name.upper():<9} {freq:9.3f}      {rms_dbfs(samples):6.1f}")

    silent = silence(2.0)
    write_wav(OUT_DIR / "silence.wav", silent)
    print(f"  {'silence.wav':<15} {'—':<9} {'—':>9}      {rms_dbfs(silent):6.1f}")

    quiet = sine_tone(midi_to_freq(69), 5.0, 0.0035)
    write_wav(OUT_DIR / "a4_quiet.wav", quiet)
    print(f"  {'a4_quiet.wav':<15} {'A4':<9} {440.0:9.3f}      {rms_dbfs(quiet):6.1f}")

    noisy = noise(3.0, 0.16)
    write_wav(OUT_DIR / "noise.wav", noisy)
    print(f"  {'noise.wav':<15} {'—':<9} {'—':>9}      {rms_dbfs(noisy):6.1f}")

    print()
    print("完成。可用系统播放器循环播放，麦克风靠近扬声器测试。")
    print()


if __name__ == "__main__":
    main()
