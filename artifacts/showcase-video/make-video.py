"""从既有八页 PDF 制作英文配音视频；所有输出只写本脚本目录。
依赖：imageio-ffmpeg==0.6.0 pymupdf==1.28.2 edge-tts==7.2.8 pillow==12.3.0
TTS 只发送已公开的产品讲稿到 Microsoft Edge 在线语音服务，不使用付费凭证。
"""
import argparse
import asyncio
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
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
FPS = 24
VOICE = 'en-US-GuyNeural'
SCENES = [
    ('Work from anywhere.', 'Work from anywhere. With Yeaft, your location can change without leaving the work behind. Connect to your AI team through a browser.'),
    ('Different devices. The same working context.', 'At home, at the office, or on the move, reconnect to the same Agent and Session. The browser is your entry point. Your online Agent provides the working environment.'),
    ('The right role. The next step.', 'Bring in the right role for the next step. An investigator finds the cause, an implementer makes the change, and a reviewer challenges it. Explicit handoffs carry the task forward, not a fixed pipeline.'),
    ('Define the roles. Set the working rules.', 'Define each role with configurable system prompts. Add shared project rules, so responsibilities, coding conventions, and review expectations travel with the work.'),
    ('Beyond chat. A real workbench.', 'Go beyond chat with Workbench. Inspect actual files, check command output, and stay close to what the Agent is doing. Delegate the work without losing visibility.'),
    ('From a development goal to execution.', 'Give AI a development goal, constraints, and acceptance criteria. For example: fix a bug, add a regression test, and prepare a patch for review, instead of scripting every next prompt.'),
    ('Keep the task moving. Keep control.', 'Work Center keeps the goal, progress, and evidence visible. Let ready work advance on the online Agent. Step in for decisions and evaluate results against acceptance criteria. Work Center is currently in Preview.'),
    ('Your AI team. Real work. From anywhere.', 'Anywhere access. Clear responsibilities. Real tools. Goal driven execution. Yeaft. Your AI team. Real work. From anywhere.'),
]


def run(args):
    result = subprocess.run([str(x) for x in args], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError(result.stderr.decode(errors='replace')[-5000:])
    return result


def ff(args):
    return run([FFMPEG, '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', *args])


def timestamp(value, ass=False):
    units = round(value * (100 if ass else 1000))
    base = 100 if ass else 1000
    secs, fraction = divmod(units, base)
    hours, secs = divmod(secs, 3600)
    mins, secs = divmod(secs, 60)
    return f'{hours}:{mins:02}:{secs:02}.{fraction:02}' if ass else f'{hours:02}:{mins:02}:{secs:02},{fraction:03}'


async def prepare(source):
    work = ROOT / 'render'
    work.mkdir(exist_ok=True)
    doc = pymupdf.open(source)
    assert len(doc) == 8
    narration = []
    for i, (title, text) in enumerate(SCENES, 1):
        p = doc[i-1]
        pix = p.get_pixmap(matrix=pymupdf.Matrix(2.5, 2.5), alpha=False)
        pix.save(str(work / f'slide-{i}.png'))
        mp3 = work / f'voice-{i}.mp3'
        boundary = work / f'voice-{i}.json'
        if not mp3.exists() or not boundary.exists():
            events = []
            comm = edge_tts.Communicate(text, VOICE, rate='-5%', boundary='WordBoundary')
            with mp3.open('wb') as audio:
                async for chunk in comm.stream():
                    if chunk['type'] == 'audio':
                        audio.write(chunk['data'])
                    elif chunk['type'] == 'WordBoundary':
                        events.append(chunk)
            boundary.write_text(json.dumps(events, indent=2))
        ff(['-i', mp3, '-ac', '1', '-ar', '24000', work / f'voice-{i}.wav'])
        with wave.open(str(work / f'voice-{i}.wav')) as wav:
            duration = wav.getnframes() / wav.getframerate()
        narration.append({'slide':i, 'title':title, 'text':text, 'voiceDuration':duration})
        print(f'Prepared slide {i}: voice {duration:.2f}s', flush=True)
    total_voice = sum(x['voiceDuration'] for x in narration)
    # 以真实音频时长排版；仅必要时轻微加速，禁止截断讲稿。
    tempo = max(1.0, total_voice / 102.0)
    if tempo > 1.15:
        raise RuntimeError('Narration too long: shorten script instead of rushing voice')
    effective = total_voice / tempo
    gap = max(0.7, (110.0 - effective) / 8)
    offset = 0
    srt = []
    contacts = []
    for n in narration:
        i = n['slide']
        duration = math.ceil((n['voiceDuration'] / tempo + gap) * FPS) / FPS
        n.update(start=offset, duration=duration, tempo=tempo)
        events = json.loads((work / f'voice-{i}.json').read_text())
        script_words = n['text'].split()
        assert len(script_words) == len(events), 'Voice word boundaries must match narration'
        for word, event in zip(script_words, events):
            assert re.sub(r'\W', '', word).lower() == re.sub(r'\W', '', event['text']).lower()
            event['text'] = word
        cues = []
        words = []
        for index, event in enumerate(events):
            words.append(event)
            chars = len(' '.join(x['text'] for x in words))
            if chars >= 56 or re.search(r'[.!?;]$', event['text']) or index == len(events)-1:
                text = ' '.join(x['text'] for x in words)
                start = 0.35 + words[0]['offset'] / 1e7 / tempo
                end = 0.35 + (words[-1]['offset'] + words[-1]['duration']) / 1e7 / tempo
                next_start = 0.35 + events[index+1]['offset'] / 1e7 / tempo if index+1 < len(events) else duration
                cues.append((start, min(end + 0.12, next_start - 0.01, duration - 0.15), text))
                words = []
        ass = ['[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1920', 'PlayResY: 1080', 'WrapStyle: 0', '[V4+ Styles]', 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding', 'Style: Default,DejaVu Sans,32,&H002B2927,&H002B2927,&H00F7F9FA,&H00F7F9FA,0,0,0,0,100,100,0,0,1,0,0,2,150,150,26,1', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text']
        for start, end, text in cues:
            ass.append(f'Dialogue: 0,{timestamp(start,True)},{timestamp(end,True)},Default,,0,0,0,,{text}')
            srt.append(f'{len(srt)+1}\n{timestamp(offset+start)} --> {timestamp(offset+end)}\n{text}\n')
        (work / f'slide-{i}.ass').write_text('\n'.join(ass), encoding='utf-8')
        image = Image.open(work / f'slide-{i}.png').convert('RGB')
        bg = image.getpixel((0,0))
        # 留出独立字幕区域，保留原稿页脚与 staged / Preview 声明。
        canvas = Image.new('RGB',(1920,1080),bg)
        image.thumbnail((1728,972),Image.Resampling.LANCZOS)
        canvas.paste(image, ((1920-image.width)//2, 0))
        canvas.save(work / f'frame-{i}.png')
        thumb = canvas.copy(); thumb.thumbnail((640,360)); contacts.append(thumb)
        offset += duration
    assert offset < 119
    (ROOT / 'yeaft-work-anywhere.en.srt').write_text('\n'.join(srt), encoding='utf-8')
    (ROOT / 'timeline.json').write_text(json.dumps({'voice':VOICE,'rate':'-5%','fps':FPS,'width':1920,'height':1080,'duration':offset,'scenes':narration},indent=2))
    (ROOT / 'narration.en.txt').write_text('\n\n'.join(n['text'] for n in narration))
    contact = Image.new('RGB',(1280,1440),'white')
    for j,img in enumerate(contacts): contact.paste(img,((j%2)*640,(j//2)*360))
    contact.save(ROOT / 'storyboard.jpg',quality=90)
    print(f'Timeline ready: {offset:.3f}s; voice tempo {tempo:.3f}',flush=True)


def render():
    work = ROOT / 'render'
    timeline = json.loads((ROOT / 'timeline.json').read_text())
    for n in timeline['scenes']:
        i,duration = n['slide'],n['duration']
        frames = round(duration * FPS)
        # 极轻的推进，不裁掉内容；短淡入淡出避免生硬切页。
        vf = f"scale=2560:1440,zoompan=z='1+0.012*on/{frames}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=1920x1080:fps={FPS},fade=t=in:st=0:d=0.20:color=0xfaf9f7,fade=t=out:st={duration-0.20}:d=0.20:color=0xfaf9f7,ass=slide-{i}.ass,format=yuv420p"
        ff(['-filter_threads','2','-loop','1','-framerate',str(FPS),'-i',work/f'frame-{i}.png','-i',work/f'voice-{i}.wav','-vf',vf,'-af',f"atempo={n['tempo']},adelay=350,apad",'-t',str(duration),'-c:v','libx264','-preset','fast','-crf','21','-threads','2','-c:a','aac','-b:a','128k','-ar','48000','-ac','2',work/f'part-{i}.mp4'])
        print(f'Rendered scene {i}/8',flush=True)
    (work/'concat.txt').write_text('\n'.join(f"file 'part-{i}.mp4'" for i in range(1,9)))
    ff(['-f','concat','-safe','0','-i',work/'concat.txt','-c','copy','-movflags','+faststart','-metadata','title=Yeaft — Work from anywhere','-metadata','comment=Eight-slide showcase; synthetic English narration; staged demo screenshots',ROOT/'yeaft-work-anywhere-en.mp4'])
    print('Video complete',flush=True)


if __name__ == '__main__':
    import os
    parser = argparse.ArgumentParser()
    parser.add_argument('phase',choices=['prepare','render'])
    parser.add_argument('--pdf',type=Path)
    args = parser.parse_args()
    if args.phase == 'prepare':
        if not args.pdf: parser.error('--pdf is required')
        asyncio.run(prepare(args.pdf))
    else:
        os.chdir(ROOT/'render')
        render()
