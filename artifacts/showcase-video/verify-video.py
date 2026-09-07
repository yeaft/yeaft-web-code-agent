"""验证完整解码、4K画幅、音轨、字幕、停留画面稳定性及七处转场。"""
import hashlib
import json
from pathlib import Path
import re
import subprocess

import imageio_ffmpeg
from PIL import Image, ImageChops, ImageStat

root = Path(__file__).resolve().parent
video = root/'yeaft-work-anywhere-en.mp4'
ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
result = subprocess.run([ffmpeg,'-hide_banner','-nostdin','-threads','2','-i',str(video),'-af','volumedetect','-f','null','-'],capture_output=True,text=True)
assert result.returncode == 0, result.stderr[-5000:]
assert not re.search(r'Error|Invalid|corrupt', result.stderr,re.I), result.stderr
match = re.search(r'Duration: (\d+):(\d+):(\d+\.\d+)',result.stderr)
assert match
h,m,s = map(float,match.groups())
duration = h*3600+m*60+s
assert 108 <= duration < 119,duration
assert '3840x2160' in result.stderr and '30 fps' in result.stderr
assert 'Video: h264' in result.stderr and 'Audio: aac' in result.stderr
volume = re.search(r'mean_volume: ([-\d.]+) dB',result.stderr)
assert volume and -30 < float(volume[1]) < -5,result.stderr


def seconds(t):
    h,m,s = t.replace(',','.').split(':')
    return int(h)*3600+int(m)*60+float(s)


def frame(time,name):
    target = root/'render'/f'{name}.png'
    subprocess.run([ffmpeg,'-hide_banner','-loglevel','error','-nostdin','-y','-threads','2','-ss',str(time),'-i',str(video),'-frames:v','1',str(target)],check=True)
    img = Image.open(target).convert('RGB')
    assert img.size == (3840,2160)
    return img


previous = 0
cues = re.findall(r'(\d\d:\d\d:\d\d,\d\d\d) --> (\d\d:\d\d:\d\d,\d\d\d)',(root/'yeaft-work-anywhere.en.srt').read_text())
assert len(cues) > 20
for start,end in cues:
    start,end = seconds(start),seconds(end)
    assert previous <= start < end <= duration
    previous = end

timeline = json.loads((root/'timeline.json').read_text())
assert abs(duration-timeline['duration']) < 0.15
assert len(timeline['scenes']) == 8
contact = Image.new('RGB',(1280,1440),'white')
transitions = Image.new('RGB',(1280,1440),'white')
stability = []
transition_differences = []
for index,scene in enumerate(timeline['scenes']):
    img = frame(scene['start']+3.5,f'check-{index+1}')
    later = frame(scene['start']+5.5,f'stability-{index+1}')
    # 排除会变化的字幕区；容许独立编码帧的极小量化差异。
    difference = ImageStat.Stat(ImageChops.difference(img.crop((0,0,3840,2020)),later.crop((0,0,3840,2020)))).mean
    assert max(difference) < 0.5,difference
    stability.append(max(difference))
    img.thumbnail((640,360))
    contact.paste(img,((index%2)*640,(index//2)*360))
    if index < 7:
        start = scene['start']+scene['duration']
        early = frame(start+0.1,f'transition-{index+1}-early')
        late = frame(start+0.5,f'transition-{index+1}-late')
        difference = ImageStat.Stat(ImageChops.difference(early,late)).mean
        assert max(difference) > 1,difference
        transition_differences.append(max(difference))
        early.thumbnail((640,360))
        transitions.paste(early,((index%2)*640,(index//2)*360))
contact.save(root/'video-preview.jpg',quality=93)
transitions.save(root/'render'/'transition-preview.jpg',quality=93)
report = dict(file=video.name,durationSeconds=duration,resolution='3840x2160',fps=30,videoCodec='H.264',audioCodec='AAC',voice='en-US-AndrewNeural (synthetic)',speechTimeStretch=False,meanVolumeDb=float(volume[1]),subtitleCues=len(cues),subtitleTimingNonOverlapping=True,scenes=8,fullDecodePassed=True,staticFrameMeanAbsoluteDifferences=stability,transitionMeanAbsoluteDifferences=transition_differences,transitions=7,transitionSeconds=0.6,bytes=video.stat().st_size,sha256=hashlib.sha256(video.read_bytes()).hexdigest(),sourceDeckCommit='ebd2745c35d526310a74344ef4a7d284a940282d',limitations=['Static slide showcase, not a live interaction recording.','Synthetic voice; no human listening review performed.','Embedded screenshots retain source resolution.','TTS source is compressed 24kHz audio; AAC bitrate is not a source-quality upgrade.','Brand pronunciation not confirmed by owner.','No background music.'])
(root/'verification.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
