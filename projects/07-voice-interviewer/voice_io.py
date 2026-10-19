"""录音与转写：两段都做成可替换的

设计取舍（这个项目最重要的一处）：
    录音用 Windows 原生 waveIn（winmm.dll），零第三方依赖。
    转写做成可替换的两条路——本地 whisper 或在线接口。
    原因：本地模型要下几百 MB，部署成本高；企业的 ASR 也不会只押一个方案，
    客户环境不一样，得能换。

    这里没有"装不上就退回打字"这种半成品逻辑：
    装不上不是产品缺陷，是部署方式的问题，所以做成可替换，而不是降级。
"""
from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import os
import struct
import sys
import time
import wave
from pathlib import Path

# ---------- 录音：Windows 原生 waveIn ----------

WAVE_MAPPER = -1
MMSYSERR_NOERROR = 0
WAVE_FORMAT_PCM = 1
WHDR_DONE = 0x00000001
CALLBACK_NULL = 0x00000000

_MMSYS_ERR = {
    2: "设备 ID 超出范围（没有这个录音设备）",
    4: "设备已被占用（麦克风被其它程序独占）",
    5: "驱动不支持这个格式（采样率/位深/声道）",
    11: "系统内存不足",
    32: "没有安装录音驱动",
    33: "驱动不支持这个功能",
    34: "设备被占用",
}


def _mm_error(code: int) -> str:
    """把 mmsystem 错误码翻成人话——不然只会看到 'rc=32'。"""
    b = ctypes.create_unicode_buffer(256)
    if ctypes.windll.winmm.waveInGetErrorTextW(code, b, 256) == MMSYSERR_NOERROR:
        msg = b.value
    else:
        msg = _MMSYS_ERR.get(code, f"未知错误 {code}")
    return f"[{code}] {msg}"


class WAVEFORMATEX(ctypes.Structure):
    _fields_ = [
        ("wFormatTag", wt.WORD),
        ("nChannels", wt.WORD),
        ("nSamplesPerSec", wt.DWORD),
        ("nAvgBytesPerSec", wt.DWORD),
        ("nBlockAlign", wt.WORD),
        ("wBitsPerSample", wt.WORD),
        ("cbSize", wt.WORD),
    ]


class WAVEHDR(ctypes.Structure):
    pass


WAVEHDR._fields_ = [
    ("lpData", ctypes.c_void_p),
    ("dwBufferLength", wt.DWORD),
    ("dwBytesRecorded", wt.DWORD),
    ("dwUser", ctypes.c_size_t),
    ("dwFlags", wt.DWORD),
    ("dwLoops", wt.DWORD),
    ("lpNext", ctypes.POINTER(WAVEHDR)),
    ("reserved", ctypes.c_size_t),
]


class WAVEINCAPSW(ctypes.Structure):
    _fields_ = [
        ("wMid", wt.WORD),
        ("wPid", wt.WORD),
        ("vDriverVersion", wt.UINT),
        ("szPname", wt.WCHAR * 32),
        ("dwFormats", wt.DWORD),
        ("wChannels", wt.WORD),
        ("wReserved1", wt.WORD),
    ]


def list_input_devices() -> list[str]:
    """枚举真实可用的录音设备（走 waveIn，不是看 WMI 列驱动）。

    这一步很关键：WMI 里能看到的"音频设备"未必是能录音的端点。
    第一版用 PowerShell 查 PnP 设备，结果列了一堆 NVIDIA / Nahimic
    的虚拟驱动，真正能录的麦克风只有一个，而且 mci 还不认。
    """
    winmm = ctypes.windll.winmm
    n = winmm.waveInGetNumDevs()
    out = []
    for i in range(n):
        caps = WAVEINCAPSW()
        rc = winmm.waveInGetDevCapsW(i, ctypes.byref(caps), ctypes.sizeof(caps))
        if rc == MMSYSERR_NOERROR:
            out.append(f"#{i} {caps.szPname} ({caps.wChannels}ch)")
    return out


def record_wav(
    out: Path,
    seconds: float = 30.0,
    samplerate: int = 16000,
    channels: int = 1,
    bits: int = 16,
    device_id: int = WAVE_MAPPER,
) -> Path:
    """录一段固定时长的 wav。不需要任何第三方包。

    用 waveIn + 内存缓冲（不是 mci）：mci 的 open new 即使成功也可能只是
    建了个空对象，真正 record 时才报"未安装波形设备"，而且拿不到细节。
    waveIn 每一步都有明确返回码，出错能说清是"没设备"还是"被占用"。

    固定时长而不是"按回车停"：免掉键盘交互，命令行里更稳。
    """
    if sys.platform != "win32":
        raise RuntimeError("这个录音实现只支持 Windows；其他系统请换 sounddevice 分支")

    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()

    winmm = ctypes.windll.winmm
    block_align = channels * bits // 8
    total_bytes = int(samplerate * seconds) * block_align

    fmt = WAVEFORMATEX(
        wFormatTag=WAVE_FORMAT_PCM,
        nChannels=channels,
        nSamplesPerSec=samplerate,
        nAvgBytesPerSec=samplerate * block_align,
        nBlockAlign=block_align,
        wBitsPerSample=bits,
        cbSize=0,
    )

    hwi = wt.HANDLE()
    rc = winmm.waveInOpen(
        ctypes.byref(hwi), wt.UINT(device_id), ctypes.byref(fmt),
        ctypes.c_size_t(0), ctypes.c_size_t(0), wt.DWORD(CALLBACK_NULL),
    )
    if rc != MMSYSERR_NOERROR:
        hint = ""
        if rc in (32, 2):
            devs = list_input_devices()
            hint = "\n本机可用录音设备：" + ("\n  " + "\n  ".join(devs) if devs else "（一个都没有）")
        raise RuntimeError(f"打不开录音设备：{_mm_error(rc)}{hint}")

    buf = ctypes.create_string_buffer(total_bytes)
    hdr = WAVEHDR()
    hdr.lpData = ctypes.cast(buf, ctypes.c_void_p)
    hdr.dwBufferLength = total_bytes
    hdr.dwBytesRecorded = 0
    hdr.dwFlags = 0
    hdr.dwLoops = 0

    try:
        rc = winmm.waveInPrepareHeader(hwi, ctypes.byref(hdr), ctypes.sizeof(hdr))
        if rc != MMSYSERR_NOERROR:
            raise RuntimeError(f"准备录音缓冲失败：{_mm_error(rc)}")
        rc = winmm.waveInStart(hwi)
        if rc != MMSYSERR_NOERROR:
            raise RuntimeError(f"开始录音失败：{_mm_error(rc)}")

        # 等缓冲区录满，或者到时
        deadline = time.time() + seconds + 2.0
        while time.time() < deadline:
            if hdr.dwFlags & WHDR_DONE:
                break
            time.sleep(0.05)

        winmm.waveInStop(hwi)
        # 复位一下，确保 dwBytesRecorded 是最新的
        winmm.waveInReset(hwi)
        got = int(hdr.dwBytesRecorded) or total_bytes
    finally:
        winmm.waveInUnprepareHeader(hwi, ctypes.byref(hdr), ctypes.sizeof(hdr))
        winmm.waveInClose(hwi)

    data = buf.raw[:got]

    with wave.open(str(out), "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(bits // 8)
        w.setframerate(samplerate)
        w.writeframes(data)

    if out.stat().st_size <= 44:
        raise RuntimeError(
            f"录音没有写进内容（{out.stat().st_size} 字节）。\n"
            "常见原因：系统没有可用的录音设备，或麦克风被别的程序独占，"
            "或 Windows 隐私设置里关掉了「允许应用访问麦克风」。"
        )
    return out


def trim_silence(src: Path, dst: Path, keep_tail: float = 0.4, threshold: int = 300) -> None:
    """剪掉尾部的静音。

    为什么用"录完再剪"而不是实时 VAD：
    实时 VAD 要装 webrtcvad 或改 waveIn 回调，为了一个练习工具不值当。
    录固定时长再剪尾巴，效果够用，代码只有十几行。
    """
    with wave.open(str(src), "rb") as w:
        n = w.getnframes()
        rate = w.getframerate()
        params = w.getparams()
        raw = w.readframes(n)

    samples = list(struct.unpack(f"<{len(raw)//2}h", raw[: len(raw) // 2 * 2]))
    win = max(1, int(rate * 0.1))  # 100ms 一块
    end = len(samples)
    while end > win:
        if max(abs(v) for v in samples[end - win:end]) >= threshold:
            break
        end -= win
    end = min(len(samples), end + int(rate * keep_tail))

    with wave.open(str(dst), "wb") as w:
        w.setnchannels(params.nchannels)
        w.setsampwidth(params.sampwidth)
        w.setframerate(rate)
        w.writeframes(struct.pack(f"<{end}h", *samples[:end]))


# ---------- 转写：可替换 ----------

class Transcriber:
    """转写器接口。子类实现 transcribe(wav_path) -> str。"""

    name = "base"

    def transcribe(self, wav_path: Path) -> str:
        raise NotImplementedError


class LocalWhisper(Transcriber):
    """本地转写。需要 faster-whisper，首次用会下载模型。

    没装的时候不隐藏、不降级，直接报清楚该怎么装。
    """
    name = "local-whisper"

    def __init__(self, model_size: str = "small"):
        try:
            from faster_whisper import WhisperModel
        except ImportError as e:
            raise RuntimeError(
                "本地转写需要 faster-whisper：\n"
                "  pip install faster-whisper\n"
                "（首次运行还会下载模型，约 500MB）"
            ) from e
        self._model = WhisperModel(model_size, device="cpu", compute_type="int8")

    def transcribe(self, wav_path: Path) -> str:
        segments, _ = self._model.transcribe(str(wav_path), language="zh")
        return "".join(s.text for s in segments).strip()


class OpenAICompatTranscriber(Transcriber):
    """走 OpenAI 兼容协议的转写接口。

    DeepSeek 目前不提供 audio 接口，这里留的是通用入口：
    换 base_url 和 model 就能接 whisper-1 / 硅基流动 / 阿里云 / 讯飞。
    企业的 ASR 本来也得能换——不能把产品绑死在某一家。
    """
    name = "openai-compatible"

    def __init__(
        self,
        base_url: str | None = None,
        model: str | None = None,
        api_key_env: str = "STT_API_KEY",
    ):
        self.base_url = base_url or os.environ.get("STT_API_BASE", "https://api.openai.com/v1")
        self.model = model or os.environ.get("STT_MODEL", "whisper-1")
        self.api_key = os.environ.get(api_key_env)
        if not self.api_key:
            raise RuntimeError(f"在线转写需要环境变量 {api_key_env}")

    def transcribe(self, wav_path: Path) -> str:
        from openai import OpenAI

        client = OpenAI(api_key=self.api_key, base_url=self.base_url)
        with open(wav_path, "rb") as f:
            r = client.audio.transcriptions.create(model=self.model, file=f, language="zh")
        return (r.text or "").strip()


def get_transcriber(prefer: str = "auto") -> Transcriber:
    """挑一个能用的转写器。

    prefer: auto / local / online
    auto 的顺序：本地能用就用本地，否则用在线；都不行就抛出明确错误，
    不静默退回打字——那会让"跑通了"变成一句假话。
    """
    order = {"auto": ["local", "online"], "local": ["local"], "online": ["online"]}[prefer]
    errors = []
    for kind in order:
        try:
            return LocalWhisper() if kind == "local" else OpenAICompatTranscriber()
        except Exception as e:
            errors.append(f"- {kind}: {e}")
    raise RuntimeError(
        "没有可用的转写方式：\n" + "\n".join(errors) +
        "\n\n二选一：\n"
        "  pip install faster-whisper                # 本地转写\n"
        "  setx STT_API_KEY <你的key>                # 在线转写（还要设 STT_API_BASE）"
    )


# ---------- wav 工具 ----------

def wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as w:
        return w.getnframes() / float(w.getframerate())


def wav_peak(path: Path) -> int:
    with wave.open(str(path), "rb") as w:
        raw = w.readframes(w.getnframes())
    body = raw[: len(raw) // 2 * 2]
    if not body:
        return 0
    return max(abs(v) for v in struct.unpack(f"<{len(body)//2}h", body))


def wav_is_silent(path: Path, threshold: int = 300) -> bool:
    """粗判静音：16bit 单声道，峰值太低就当没说话。"""
    return wav_peak(path) < threshold


if __name__ == "__main__":
    print("录音输入设备：")
    devs = list_input_devices()
    for d in devs:
        print("  -", d)
    if not devs:
        raise SystemExit("一个录音设备都没有，先插麦克风。")

    p = Path(__file__).parent / "audio" / "_mic_test.wav"
    secs = float(os.environ.get("VI_TEST_SECS", "3"))
    print(f"\n录 {secs:g} 秒，请说点什么…")
    t0 = time.time()
    record_wav(p, seconds=secs)
    print(
        f"已保存 {p}：{p.stat().st_size} 字节，"
        f"时长 {wav_duration(p):.1f} 秒，峰值 {wav_peak(p)}，"
        f"静音={wav_is_silent(p)}，耗时 {time.time() - t0:.1f}s"
    )
