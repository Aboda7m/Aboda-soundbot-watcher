import { createResource } from "../src/voice/AudioProvider.ts";
const [file, runs] = [process.argv[2]!, Number(process.argv[3] ?? 10)];
let packets = 0;
for (let i = 0; i < runs; i++) for await (const _ of createResource(file).playStream) packets++;
console.log(`${file}: ${runs} plays, ${packets} packets`);
