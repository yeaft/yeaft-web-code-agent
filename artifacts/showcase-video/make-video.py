"""从八页 PDF 制作稳定 4K 演示视频，使用公开讲稿调用 Edge 在线 TTS。
依赖版本见 README。中间文件只写入本目录 render/；不修改在线服务。
"""
import argparse
import asyncio
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
import wave

import edge_tts
import imageio_ffmpeg
import pymupdf
from PIL import Image

ROOT = Path(__file__).resolve().parent
WORK = ROOT / 'render'
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
FPS, WIDTH, HEIGHT = 30, 3840, 2160
VOICE = 'en-US-AndrewNeural'
TRANSITION = 0.6
SCENES = [
    ('Work from anywhere.', 'Work from anywhere. With Yeaft, you can change location without leaving your work behind. Just open a browser and connect to your AI team.'),
    ('Different devices. The same working context.', 'At home, at the office, or on the move. Reconnect to the same agent and session. Your browser gives you access. Your online agent keeps the working environment in place.'),
    ('The right role. The next step.', 'Bring in the right role for each step. An investigator finds the cause. An implementer makes the change. A reviewer checks the result. Clear handoffs move the work forward, without a fixed pipeline.'),
    ('Define the roles. Set the working rules.', 'Give each role clear instructions. Add shared project rules, so responsibilities, coding standards, and review expectations stay consistent as the work moves between roles.'),
    ('Beyond chat. A real workbench.', 'Go beyond chat with Workbench. Open the actual files. Check command output. See what your agent is doing, and step in when you need to.'),
    ('From a development goal to execution.', 'Start with a development goal, clear boundaries, and acceptance criteria. Fix a bug. Add a regression test. Prepare a patch for review. Describe the outcome, rather than every next prompt.'),
    ('Keep the task moving. Keep control.', 'Work Center keeps your goal, progress, and evidence in view. Let ready work advance while your agent is online. Step in for decisions, and check the results against your criteria. Work Center is in preview.'),
    ('Your AI team. Real work. From anywhere.', 'Work from anywhere. Clear roles. Real tools. Yeaft. Your AI team, doing real work.'),
]


def ff(args):
    result = subprocess.run([FFMPEG, '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', *map(str, args)], capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr.decode(errors='replace')[-5000:])
    return result


def timestamp(value, ass=False):
    base = 100 if ass else 1000
    secs, fraction = divmod(round(value * base), base)
    hours, secs = divmod(secs, 3600)
    mins, secs = divmod(secs, 60)
    return f'{hours}:{mins:02}:{secs:02}.{fraction:02}' if ass else f'{hours:02}:{mins:02}:{secs:02},{fraction:03}'


async def prepare(source):
    WORK.mkdir(exist_ok=True)
    narration = []
    with pymupdf.open(source) as doc:
        assert len(doc) == 8
        for i, (title, text) in enumerate(SCENES, 1):
            page = doc[i-1]
            # 直接从 PDF 光栅化到最终内容宽度，不进行逐帧缩放。
            pix = page.get_pixmap(matrix=pymupdf.Matrix(3600 / page.rect.width, 3600 / page.rect.width), alpha=False)
            image = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
            canvas = Image.new('RGB', (WIDTH, HEIGHT), image.getpixel((0, 0)))
            canvas.paste(image, ((WIDTH-image.width)//2, 0))
            canvas.save(WORK / f'frame-{i}.png')
            key = hashlib.sha256((VOICE+'|+0%|'+text).encode()).hexdigest()[:16]
            mp3, boundary = WORK/f'{key}.mp3', WORK/f'{key}.json'
            if not mp3.exists() or not boundary.exists():
                events = []
                comm = edge_tts.Communicate(text, VOICE, rate='+0%', boundary='WordBoundary')
                with mp3.open('wb') as audio:
                    async for chunk in comm.stream():
                        if chunk['type'] == 'audio':
                            audio.write(chunk['data'])
                        elif chunk['type'] == 'WordBoundary':
                            events.append(chunk)
                boundary.write_text(json.dumps(events, indent=2))
            ff(['-i', mp3, '-ac', '1', '-ar', '24000', WORK/f'voice-{i}.wav'])
            with wave.open(str(WORK/f'voice-{i}.wav')) as wav:
                duration = wav.getnframes()/wav.getframerate()
            narration.append(dict(slide=i, title=title, text=text, voiceDuration=duration, boundary=boundary.name))
            print(f'Prepared slide {i}: {duration:.2f}s', flush=True)
    total_voice = sum(n['voiceDuration'] for n in narration)
    gap = max(0.9, (110 - total_voice - 7*TRANSITION)/8)
    offset, srt, contacts = 0, [], []
    for n in narration:
        i = n['slide']
        duration = math.ceil((n['voiceDuration'] + gap)*FPS)/FPS
        n.update(start=offset, duration=duration, tempo=1.0)
        events = json.loads((WORK/n['boundary']).read_text())
        script_words = n['text'].split()
        assert len(script_words) == len(events), (i, script_words, events)
        for word, event in zip(script_words, events):
            assert re.sub(r'\W', '', word).lower() == re.sub(r'\W', '', event['text']).lower()
            event['text'] = word
        cues, words = [], []
        for index, event in enumerate(events):
            words.append(event)
            text = ' '.join(x['text'] for x in words)
            if len(text) >= 54 or re.search(r'[.!?;]$', event['text']) or index == len(events)-1:
                start = 0.35 + words[0]['offset']/1e7
                end = 0.35 + (event['offset']+event['duration'])/1e7
                next_start = 0.35+events[index+1]['offset']/1e7 if index+1 < len(events) else duration
                cues.append((start, min(end+0.12, next_start-0.01, duration-0.15), text))
                words = []
        ass = ['[Script Info]', 'ScriptType: v4.00+', f'PlayResX: {WIDTH}', f'PlayResY: {HEIGHT}', 'WrapStyle: 0', '[V4+ Styles]', 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding', 'Style: Default,DejaVu Sans,64,&H002B2927,&H002B2927,&H00F7F9FA,&H00F7F9FA,0,0,0,0,100,100,0,0,1,0,0,2,240,240,40,1', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text']
        for start, end, text in cues:
            ass.append(f'Dialogue: 0,{timestamp(start,True)},{timestamp(end,True)},Default,,0,0,0,,{text}')
            srt.append(f'{len(srt)+1}\n{timestamp(offset+start)} --> {timestamp(offset+end)}\n{text}\n')
        (WORK/f'slide-{i}.ass').write_text('\n'.join(ass), encoding='utf-8')
        image = Image.open(WORK/f'frame-{i}.png').convert('RGB')
        image.thumbnail((640,360)); contacts.append(image)
        offset += duration + (TRANSITION if i < 8 else 0)
    assert offset < 119, f'Shorten narration instead of accelerating: {offset:.2f}s'
    (ROOT/'yeaft-work-anywhere.en.srt').write_text('\n'.join(srt))
    (ROOT/'timeline.json').write_text(json.dumps(dict(voice=VOICE, rate='+0%', fps=FPS, width=WIDTH, height=HEIGHT, duration=offset, transitionSeconds=TRANSITION, transition='cross dissolve', sourceAudioSampleRate=24000, scenes=narration), indent=2)+'\n')
    (ROOT/'narration.en.txt').write_text('\n\n'.join(n['text'] for n in narration)+'\n')
    contact = Image.new('RGB', (1280,1440), 'white')
    for j, img in enumerate(contacts): contact.paste(img, ((j%2)*640,(j//2)*360))
    contact.save(ROOT/'storyboard.jpg', quality=93)
    print(f'Timeline ready: {offset:.3f}s; no speech time stretching', flush=True)


def render():
    timeline = json.loads((ROOT/'timeline.json').read_text())
    # 所有片段使用一致的视频和 PCM 音频参数；最终仅编码一次 AAC，避免拼接音频间隙。
    codec = ['-c:v','libx264','-preset','fast','-tune','stillimage','-crf','14','-threads','2','-pix_fmt','yuv420p','-r',FPS,'-c:a','pcm_s16le','-ar','48000','-ac','2']
    parts = []
    for n in timeline['scenes']:
        i = n['slide']
        target = WORK/f'hold-{i}.mkv'
        ff(['-filter_threads','2','-loop','1','-framerate',FPS,'-i',WORK/f'frame-{i}.png','-i',WORK/f'voice-{i}.wav','-vf',f'ass={WORK}/slide-{i}.ass','-af','loudnorm=I=-18:TP=-2:LRA=7,adelay=350,apad','-t',n['duration'],*codec,target])
        parts.append(target.name)
        if i < 8:
            target = WORK/f'transition-{i}.mkv'
            ff(['-filter_complex_threads','1','-loop','1','-framerate',FPS,'-i',WORK/f'frame-{i}.png','-loop','1','-framerate',FPS,'-i',WORK/f'frame-{i+1}.png','-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-filter_complex',f'[0:v][1:v]xfade=transition=fade:duration={TRANSITION}:offset=0,format=yuv420p[v]','-map','[v]','-map','2:a','-t',TRANSITION,*codec,target])
            parts.append(target.name)
        print(f'Rendered stable scene {i}/8 and following transition', flush=True)
    (WORK/'concat.txt').write_text('\n'.join(f"file '{name}'" for name in parts))
    ff(['-f','concat','-safe','0','-i',WORK/'concat.txt','-c:v','copy','-c:a','aac','-b:a','192k','-movflags','+faststart','-metadata','title=Yeaft — Work from anywhere','-metadata','comment=4K static slides; cross dissolves; synthetic Andrew narration',ROOT/'yeaft-work-anywhere-en.mp4'])
    print('Video complete', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('phase', choices=['prepare','render'])
    parser.add_argument('--pdf', type=Path)
    args = parser.parse_args()
    if args.phase == 'prepare':
        if not args.pdf: parser.error('--pdf is required')
        asyncio.run(prepare(args.pdf))
    else:
        render()
