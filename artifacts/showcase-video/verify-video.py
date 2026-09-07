"""验证成片完整解码、时长、画幅、音轨、字幕范围，并抽取每页画面。"""
import hashlib
import json
from pathlib import Path
import re
import subprocess

import imageio_ffmpeg
from PIL import Image

root = Path(__file__).resolve().parent
video = root / 'yeaft-work-anywhere-en.mp4'
ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
result = subprocess.run([ffmpeg, '-hide_banner', '-nostdin', '-i', str(video), '-af', 'volumedetect', '-f', 'null', '-'], capture_output=True, text=True)
assert result.returncode == 0, result.stderr[-5000:]
assert not re.search(r'Error|Invalid|corrupt', result.stderr, re.I), result.stderr
match = re.search(r'Duration: (\d+):(\d+):(\d+\.\d+)', result.stderr)
assert match
h,m,s = map(float, match.groups())
duration = h*3600 + m*60 + s
assert 108 <= duration < 119, duration
assert '1920x1080' in result.stderr and '24 fps' in result.stderr
assert 'Video: h264' in result.stderr and 'Audio: aac' in result.stderr
volume = re.search(r'mean_volume: ([-\d.]+) dB', result.stderr)
assert volume and -40 < float(volume[1]) < -5, result.stderr

def seconds(t):
    h,m,s = t.replace(',', '.').split(':')
    return int(h)*3600+int(m)*60+float(s)

previous = 0
cues = re.findall(r'(\d\d:\d\d:\d\d,\d\d\d) --> (\d\d:\d\d:\d\d,\d\d\d)', (root/'yeaft-work-anywhere.en.srt').read_text())
for start,end in cues:
    start,end = seconds(start),seconds(end)
    assert previous <= start < end <= duration
    previous = end

timeline = json.loads((root/'timeline.json').read_text())
assert len(timeline['scenes']) == 8
contact = Image.new('RGB',(1280,1440),'white')
for index,scene in enumerate(timeline['scenes']):
    time = scene['start'] + min(3.5,scene['duration']/2)
    target = root/'render'/f'check-{index+1}.png'
    subprocess.run([ffmpeg,'-hide_banner','-loglevel','error','-nostdin','-y','-ss',str(time),'-i',str(video),'-frames:v','1',str(target)],check=True)
    img = Image.open(target).convert('RGB')
    assert img.size == (1920,1080)
    img.thumbnail((640,360))
    contact.paste(img,((index%2)*640,(index//2)*360))
contact.save(root/'video-preview.jpg',quality=93)
report = {'file':video.name,'durationSeconds':duration,'resolution':'1920x1080','fps':24,'videoCodec':'H.264','audioCodec':'AAC','voice':'en-US-GuyNeural (synthetic)','meanVolumeDb':float(volume[1]),'subtitleCues':len(cues),'subtitleTimingNonOverlapping':True,'scenes':8,'fullDecodePassed':True,'bytes':video.stat().st_size,'sha256':hashlib.sha256(video.read_bytes()).hexdigest(),'sourceDeckCommit':'ebd2745c35d526310a74344ef4a7d284a940282d','limitations':['Static slide showcase, not a live interaction recording.','Synthetic voice; no human listening review performed.','No background music.']}
(root/'verification.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
