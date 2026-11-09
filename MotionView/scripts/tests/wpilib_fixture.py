"""Generate a WPILOG fixture and exercise the bridge with a real WPILib NT4 server.

Run from MotionView with the bridge requirements and RobotPy's pyntcore installed.
Pass a scratch directory for the generated files.
"""
import asyncio
import json
import math
import socket
import struct
import sys
from pathlib import Path

import ntcore
import uvicorn
from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus
from wpiutil.log import DataLogReader

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))
import bridge

TOPICS = ["/vL", "/vR", "/velL", "/velR", "/posL", "/posR", "/state", "/pose"]
ORIGIN = "http://localhost:1420"
TOKEN = "fixture-token"


def create_wpilog(path):
    def record(entry, timestamp, data):
        return struct.pack("<BIIQ", 0x7F, entry, len(data), timestamp) + data

    def text(value):
        payload = value.encode()
        return struct.pack("<I", len(payload)) + payload

    result = bytearray(b"WPILOG\x00\x01\x00\x00\x00\x00")
    for i, topic in enumerate(TOPICS, 1):
        kind = "string" if topic == "/state" else "struct:Pose2d" if topic == "/pose" else "double"
        result.extend(record(0, 500, struct.pack("<BI", 0, i) + text(topic) + text(kind) + text("{}")))
    for group, state in enumerate(["quasistatic-forward", "quasistatic-reverse", "dynamic-forward", "dynamic-reverse"]):
        start = 1_000_000 + group * 2_000_000
        result.extend(record(7, start - 1, state.encode()))
        sign = 1 if group % 2 == 0 else -1
        v = pos = 0.0
        for i in range(160):
            us = start + i * 10_000
            volts = i * .03 if group < 2 else 6
            for entry, value in enumerate([volts, volts, v, v, pos, pos], 1):
                if group == 0 and i == 8 and entry == 2:
                    continue  # one missing voltage update
                result.extend(record(entry, us + entry * 100, struct.pack("<d", value * sign)))
            result.extend(record(8, us + 900, struct.pack("<ddd", pos * sign, .5, .1)))
            steady = (max(0, volts - .3)) / 2.2
            v += (steady - v) * -math.expm1(-.01 * 2.2 / .5)
            pos += v * .01
        result.extend(record(7, start + 1_800_000, b"none"))
    result.extend(record(0, 9_000_000, struct.pack("<BI", 1, 8)))
    path.write_bytes(result)
    reader = DataLogReader(str(path))
    assert reader.isValid()
    assert sum(not row.isControl() for row in reader) == 4487


async def create_live_capture(directory):
    def listener():
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        return sock

    with listener() as bridge_socket, listener() as robot_socket:
        bridge_port = bridge_socket.getsockname()[1]
        robot_port = robot_socket.getsockname()[1]
        robot_socket.close()
        instance = ntcore.NetworkTableInstance.create()
        instance.startServer(str(directory / "networktables.json"), "127.0.0.1", 0, robot_port)
        bridge.BRIDGE_TOKEN = TOKEN
        bridge.ALLOWED_ORIGINS = {ORIGIN}
        server = uvicorn.Server(uvicorn.Config(bridge.app, log_level="error", lifespan="off"))
        task = asyncio.create_task(server.serve(sockets=[bridge_socket]))
        try:
            while not server.started:
                await asyncio.sleep(.01)
            url = f"ws://127.0.0.1:{bridge_port}/ws/sysid-nt4?token={TOKEN}"
            try:
                async with connect(url, origin="http://example.invalid"):
                    raise AssertionError("unauthorized origin accepted")
            except InvalidStatus as error:
                assert error.response.status_code == 403
            options = ntcore.PubSubOptions(sendAll=True, keepDuplicates=True)
            publishers = [instance.getDoubleTopic(name).publish(options) for name in TOPICS[:6]]
            state = instance.getStringTopic("/state").publish(options)
            pose = instance.getDoubleArrayTopic("/pose").publish(options)
            stale = ntcore._now() - 1_000_000
            for publisher in publishers:
                publisher.set(9.0, stale)
            state.set("dynamic-forward", stale)
            async with connect(url, origin=ORIGIN) as client:
                await client.send(json.dumps({"host": f"127.0.0.1:{robot_port}", "topics": TOPICS + ["/missing"]}))
                assert json.loads(await asyncio.wait_for(client.recv(), 8))["kind"] == "connected"
                announced = set()
                while len(announced) < len(TOPICS):
                    message = json.loads(await asyncio.wait_for(client.recv(), 3))
                    if message["kind"] == "topic":
                        announced.add(message["name"])
                base = ntcore._now()
                expected = []
                for i in range(30):
                    stamp = base + i * 10_000
                    expected.append(stamp + 200)
                    for index, publisher in enumerate(publishers):
                        publisher.set(float(index + 1), stamp + index * 100)
                    pose.set([1.0, 2.0, .25], stamp + 900)
                    instance.flush()
                    await asyncio.sleep(.01)
                values = []
                while len([event for event in values if event["name"] == "/velL"]) < 30:
                    message = json.loads(await asyncio.wait_for(client.recv(), 3))
                    if message["kind"] == "samples":
                        values.extend(message["values"])
                assert [event["us"] for event in values if event["name"] == "/velL"] == expected
                assert any(event["name"] == "/state" and event["us"] == stale for event in values)
                assert all(event["name"] == "/state" or event["us"] >= base for event in values)
                assert "/missing" not in announced
                instance.stopServer()
                message = json.loads(await asyncio.wait_for(client.recv(), 7))
                while message["kind"] == "samples":
                    values.extend(message["values"])
                    message = json.loads(await asyncio.wait_for(client.recv(), 7))
                assert message["kind"] == "error", message
                (directory / "nt4-events.json").write_text(json.dumps(values))
        finally:
            server.should_exit = True
            await task
            ntcore.NetworkTableInstance.destroy(instance)


if __name__ == "__main__":
    output = Path(sys.argv[1]).resolve()
    output.mkdir(parents=True, exist_ok=True)
    create_wpilog(output / "drive.wpilog")
    asyncio.run(create_live_capture(output))
    print("WPILib reader, real NT4 subscription, robot timestamps, and disconnect verified.")
