# /// script
# dependencies = ["websockets>=16,<17"]
# ///
"""Exercise berd-call URL overrides with loopback services and a PCM test host."""
import argparse
import asyncio
import json
import os
import socket
import struct
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit
from websockets.exceptions import ConnectionClosed
from websockets.asyncio.server import serve

async def main(binary):
    observed = []
    sandbox = TemporaryDirectory(prefix="berd-voice-routing-")
    config = Path(sandbox.name) / "config" / "openai-voice-endpoints.json"
    config.parent.mkdir()
    saved_settings = b'{"stt":"wss://saved.example/stt","tts":"https://saved.example/tts","realtime":"wss://saved.example/realtime"}'
    config.write_bytes(saved_settings)
    async def websocket(ws):
        observed.append(urlsplit(ws.request.path).path)
        assert ws.request.headers["Authorization"] == "Bearer disposable-routing-test"
        try:
            async for raw in ws:
                event = json.loads(raw)
                if event.get('type') == 'session.update':
                    session = event['session']
                    await ws.send(json.dumps({'type': 'session.updated', 'session': {
                        'model': 'test-model', 'audio': session.get('audio', {})
                    }}))
        except ConnectionClosed:
            pass
    async def synthesis(reader, writer):
        headers = await reader.readuntil(b'\r\n\r\n')
        length = next(int(line.split(b':', 1)[1]) for line in headers.split(b'\r\n') if line.lower().startswith(b'content-length:'))
        body = json.loads(await reader.readexactly(length))
        assert body['input'] == 'A lighthouse guides the boat home.'
        observed.append(headers.split(b' ')[1].decode())
        pcm = b'\x00\x00' * 2400
        writer.write(b'HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: ' + str(len(pcm)).encode() + b'\r\nConnection: close\r\n\r\n' + pcm)
        await writer.drain()
        writer.close()
    async with serve(websocket, '127.0.0.1', 0) as ws_server:
        http = await asyncio.start_server(synthesis, '127.0.0.1', 0)
        ws_port = ws_server.sockets[0].getsockname()[1]
        http_port = http.sockets[0].getsockname()[1]
        async def run(options, speak=False, defaults=False):
            child_audio, host_audio = socket.socketpair()
            env = dict(os.environ, OPENAI_API_KEY='disposable-routing-test', OPENAI_REALTIME_MODEL='test-model', OPENAI_REALTIME_ENDPOINT='ws://127.0.0.1:1/unused', OPENAI_BASE_URL='http://127.0.0.1:1/unused')
            env['GOOSE_PATH_ROOT'] = sandbox.name
            if defaults:
                env['OPENAI_REALTIME_ENDPOINT'] = f'ws://127.0.0.1:{ws_port}/default-stt'
                env['OPENAI_BASE_URL'] = f'http://127.0.0.1:{http_port}/default'
            process = await asyncio.create_subprocess_exec(str(binary), 'session', '--pcm-output-fd', str(child_audio.fileno()), *options, env=env, pass_fds=(child_audio.fileno(),), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            child_audio.close()
            async def send(value):
                payload = json.dumps(value).encode()
                process.stdin.write(b'BV\x03\x01' + struct.pack('<I', len(payload)) + payload)
                await process.stdin.drain()
            async def pcm_host():
                reader, writer = await asyncio.open_connection(sock=host_audio)
                current = 0
                try:
                    while True:
                        head = await reader.readexactly(8)
                        assert head[:3] == b'BA\x03'
                        payload = await reader.readexactly(struct.unpack('<I', head[4:])[0])
                        speech_id = struct.unpack('<Q', payload[:8])[0]
                        if head[3] == 1:
                            current = 0
                            await send({'type':'audio_begin_accepted','speech_id':speech_id})
                        elif head[3] == 2:
                            seq = struct.unpack('<Q',payload[8:16])[0]
                            current += (len(payload)-16)//4
                            await send({'type':'audio_chunk_accepted','speech_id':speech_id,'sequence':seq})
                            await send({'type':'audio_played','speech_id':speech_id,'played_frames':current})
                        elif head[3] == 3:
                            seq = struct.unpack('<Q',payload[8:16])[0]
                            await send({'type':'audio_drained','speech_id':speech_id,'sequence':seq,'played_frames':current})
                        elif head[3] == 4:
                            await send({'type':'audio_cancelled','speech_id':speech_id,'played_frames':current})
                except asyncio.IncompleteReadError:
                    pass
                finally:
                    writer.close()
            audio_task = asyncio.create_task(pcm_host())
            try:
                await send({'type':'hello','id':1,'input_during_tts':'allow_barge_in'})
                ready = json.loads(await asyncio.wait_for(process.stdout.readline(), 10))
                assert ready['type'] == 'ready', ready
                if speak:
                    await send({'type':'prepare_speak','id':2,'acknowledgement':None,'text':'A lighthouse guides the boat home.'})
                    while True:
                        event = json.loads(await asyncio.wait_for(process.stdout.readline(), 10))
                        if event['type'] == 'admitted':
                            await send({'type':'output_ready','id':2,'speech_id':event['speech_id']})
                        if event['type'] == 'speech_completed':
                            break
                        assert event['type'] not in ('fatal','speech_failed','not_admitted'), event
                await send({'type':'shutdown'})
                await asyncio.wait_for(process.wait(), 10)
                assert process.returncode == 0, (await process.stderr.read()).decode()
            finally:
                if process.returncode is None:
                    process.kill()
                    await process.wait()
                await audio_task
        await run(['--tts-backend','openai','--stt-backend','openai','--stt-url',f'ws://127.0.0.1:{ws_port}/stt','--tts-url',f'http://127.0.0.1:{http_port}/tts'], True)
        await run(['--mode','expert-spokesperson','--tts-backend','openai','--realtime-url',f'ws://127.0.0.1:{ws_port}/realtime'])
        await run(['--tts-backend','openai','--stt-backend','openai'], True, True)
        http.close()
        await http.wait_closed()
    assert sorted(observed) == ['/default-stt','/default/audio/speech','/realtime','/stt','/tts'], observed
    assert config.read_bytes() == saved_settings
    sandbox.cleanup()
    print(json.dumps({'requests':observed,'speech':'completed','savedSettings':'unchanged','nextSession':'uses environment defaults','audio':'PCM test host, no microphone or speakers'}, indent=2))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    args = parser.parse_args()
    asyncio.run(main(args.binary.resolve()))
