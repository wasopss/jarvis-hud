// Masterização da voz do Jarvis (qualidade de dublagem/broadcast), tudo local com AVFoundation.
// Uso: master <entrada.wav> <saida.wav> [--lufs -16] [--stereo]
// Cadeia: passa-alta 80 Hz → equalizador (menos "embolado", mais presença e brilho, de-esser suave)
//         → compressor → normalização de loudness (LUFS, padrão de streaming) → limitador de pico (-1 dBFS)
import AVFoundation
import Accelerate
import Foundation

let args = CommandLine.arguments
guard args.count >= 3 else { print("uso: master entrada.wav saida.wav [--lufs -16] [--stereo]"); exit(1) }
let inURL = URL(fileURLWithPath: args[1]), outURL = URL(fileURLWithPath: args[2])
var targetLUFS = -16.0, stereo = false
if let i = args.firstIndex(of: "--lufs"), i + 1 < args.count, let v = Double(args[i + 1]) { targetLUFS = v }
if args.contains("--stereo") { stereo = true }

func fail(_ m: String) -> Never { FileHandle.standardError.write((m + "\n").data(using: .utf8)!); exit(2) }

// ---------- 1) leitura ----------
guard let inFile = try? AVAudioFile(forReading: inURL) else { fail("não consegui ler \(inURL.path)") }
let sr = inFile.processingFormat.sampleRate
let fmt = AVAudioFormat(standardFormatWithSampleRate: sr, channels: 1)!
let frames = AVAudioFrameCount(inFile.length)
guard frames > 0, let inBuf = AVAudioPCMBuffer(pcmFormat: inFile.processingFormat, frameCapacity: frames) else { fail("áudio vazio") }
try! inFile.read(into: inBuf)
// mono (a voz é mono): média dos canais
let mono = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: frames)!
mono.frameLength = inBuf.frameLength
let chs = Int(inBuf.format.channelCount)
for i in 0..<Int(inBuf.frameLength) {
  var s: Float = 0
  for c in 0..<chs { s += inBuf.floatChannelData![c][i] }
  mono.floatChannelData![0][i] = s / Float(chs)
}

// ---------- 1b) redução de ruído espectral (perfil de ruído medido nos trechos mais silenciosos) ----------
func spectralDenoise(_ x: [Float], alpha: Float, floorGain: Float) -> [Float] {
  let N = 1024, half = N / 2, hop = 256, log2n = vDSP_Length(10)
  guard x.count > N * 4, let setup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2)) else { return x }
  defer { vDSP_destroy_fftsetup(setup) }
  var win = [Float](repeating: 0, count: N)
  vDSP_hann_window(&win, vDSP_Length(N), Int32(vDSP_HANN_NORM))
  let pad = [Float](repeating: 0, count: N) + x + [Float](repeating: 0, count: N)
  let frames = (pad.count - N) / hop + 1
  var re = [Float](repeating: 0, count: half), im = [Float](repeating: 0, count: half), buf = [Float](repeating: 0, count: N)
  func forward(_ start: Int) {
    for i in 0..<N { buf[i] = pad[start + i] * win[i] }
    re.withUnsafeMutableBufferPointer { r in im.withUnsafeMutableBufferPointer { m in
      var sc = DSPSplitComplex(realp: r.baseAddress!, imagp: m.baseAddress!)
      buf.withUnsafeBufferPointer { b in b.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: half) { vDSP_ctoz($0, 2, &sc, 1, vDSP_Length(half)) } }
      vDSP_fft_zrip(setup, &sc, 1, log2n, FFTDirection(FFT_FORWARD))
    } }
  }
  func mag(_ k: Int) -> Float { k == 0 ? abs(re[0]) : k == half ? abs(im[0]) : sqrtf(re[k] * re[k] + im[k] * im[k]) }
  // passada 1: espectro de cada quadro e sua energia
  var mags = [[Float]](), energy = [Float]()
  mags.reserveCapacity(frames)
  for f in 0..<frames {
    forward(f * hop)
    var m = [Float](repeating: 0, count: half + 1); var e: Float = 0
    for k in 0...half { m[k] = mag(k); e += m[k] * m[k] }
    mags.append(m); energy.append(e)
  }
  // perfil de ruído: média dos 12% de quadros mais silenciosos (pausas e respiros)
  let order = energy.indices.sorted { energy[$0] < energy[$1] }
  let quiet = order.prefix(max(4, frames * 12 / 100))
  var noise = [Float](repeating: 0, count: half + 1)
  for f in quiet { for k in 0...half { noise[k] += mags[f][k] } }
  for k in 0...half { noise[k] /= Float(quiet.count) }
  // passada 2: ganho por faixa (subtração espectral com piso e suavização no tempo) e reconstrução
  var out = [Float](repeating: 0, count: pad.count), norm = [Float](repeating: 0, count: pad.count)
  var prev = [Float](repeating: 1, count: half + 1)
  let scale = 1 / Float(2 * N)
  for f in 0..<frames {
    forward(f * hop)
    var g = [Float](repeating: 1, count: half + 1)
    for k in 0...half {
      let m = mags[f][k]
      let raw = max(floorGain, 1 - alpha * noise[k] / (m + 1e-9))
      g[k] = 0.55 * raw + 0.45 * prev[k] // suaviza para evitar o som "metálico"
    }
    prev = g
    re[0] *= g[0]; im[0] *= g[half]
    for k in 1..<half { re[k] *= g[k]; im[k] *= g[k] }
    re.withUnsafeMutableBufferPointer { r in im.withUnsafeMutableBufferPointer { m in
      var sc = DSPSplitComplex(realp: r.baseAddress!, imagp: m.baseAddress!)
      vDSP_fft_zrip(setup, &sc, 1, log2n, FFTDirection(FFT_INVERSE))
      buf.withUnsafeMutableBufferPointer { b in b.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: half) { vDSP_ztoc(&sc, 1, $0, 2, vDSP_Length(half)) } }
    } }
    let s = f * hop
    for i in 0..<N { out[s + i] += buf[i] * scale * win[i]; norm[s + i] += win[i] * win[i] }
  }
  var y = [Float](repeating: 0, count: x.count)
  for i in 0..<x.count { let j = i + N; y[i] = norm[j] > 1e-6 ? out[j] / norm[j] : 0 }
  return y
}
var denoiseOn = !args.contains("--sem-ruido-off")
if args.contains("--no-denoise") { denoiseOn = false }
var denoiseAlpha: Float = 1.3   // suave: preserva consoantes fracas (s, f, t) e palavras curtas
if let i = args.firstIndex(of: "--denoise"), i + 1 < args.count, let v = Float(args[i + 1]) { denoiseAlpha = v }
if denoiseOn {
  let src = Array(UnsafeBufferPointer(start: mono.floatChannelData![0], count: Int(mono.frameLength)))
  let clean = spectralDenoise(src, alpha: denoiseAlpha, floorGain: 0.32) // reduz no máximo ~10 dB
  clean.withUnsafeBufferPointer { p in _ = memcpy(mono.floatChannelData![0], p.baseAddress!, clean.count * 4) }
}

// ---------- 2) EQ + compressor (render offline) ----------
let engine = AVAudioEngine()
let player = AVAudioPlayerNode()
let eq = AVAudioUnitEQ(numberOfBands: 7)
func band(_ i: Int, _ type: AVAudioUnitEQFilterType, _ f: Float, _ gain: Float, _ bw: Float) {
  let b = eq.bands[i]; b.filterType = type; b.frequency = f; b.gain = gain; b.bandwidth = bw; b.bypass = false
}
band(0, .highPass, 80, 0, 0.5)          // tira ronco e grave de sala
band(1, .parametric, 280, -2.5, 1.2)    // menos "embolado"
band(2, .parametric, 3200, 2.5, 1.0)    // presença e clareza das palavras
band(3, .parametric, 7800, -0.6, 0.35)  // de-esser bem leve (s e f continuam nítidos)
band(4, .highShelf, 11000, 2.0, 0.5)    // brilho / "ar"
band(5, .lowShelf, 140, 1.0, 0.5)       // corpo da voz grave
band(6, .parametric, 5000, 1.8, 1.1)    // clareza das consoantes (t, p, f, ch)
eq.globalGain = 0
// --so-ruido: só tira o ruído (para a gravação de referência do clone): sem EQ, compressor, gate nem mudança de volume
let onlyDenoise = args.contains("--so-ruido")
if onlyDenoise { for b in eq.bands { b.bypass = true } }

let comp = AVAudioUnitEffect(audioComponentDescription: AudioComponentDescription(
  componentType: kAudioUnitType_Effect, componentSubType: kAudioUnitSubType_DynamicsProcessor,
  componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0))
func setP(_ id: AudioUnitParameterID, _ v: Float) { AudioUnitSetParameter(comp.audioUnit, id, kAudioUnitScope_Global, 0, v, 0) }
setP(kDynamicsProcessorParam_Threshold, -22)   // dB
setP(kDynamicsProcessorParam_HeadRoom, 8)       // ~3:1
setP(kDynamicsProcessorParam_AttackTime, 0.006)
setP(kDynamicsProcessorParam_ReleaseTime, 0.09)
setP(kDynamicsProcessorParam_OverallGain, 4)    // compensação

if onlyDenoise { comp.bypass = true }
engine.attach(player); engine.attach(eq); engine.attach(comp)
engine.connect(player, to: eq, format: fmt)
engine.connect(eq, to: comp, format: fmt)
engine.connect(comp, to: engine.mainMixerNode, format: fmt)
try! engine.enableManualRenderingMode(.offline, format: fmt, maximumFrameCount: 4096)
try! engine.start()
player.scheduleBuffer(mono, completionHandler: nil)
player.play()
let tail = AVAudioFrameCount(sr * 0.25)
let total = mono.frameLength + tail
let proc = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: total)!
let chunk = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat, frameCapacity: engine.manualRenderingMaximumFrameCount)!
while proc.frameLength < total {
  let n = min(chunk.frameCapacity, total - proc.frameLength)
  guard (try? engine.renderOffline(n, to: chunk)) == .success else { break }
  memcpy(proc.floatChannelData![0] + Int(proc.frameLength), chunk.floatChannelData![0], Int(chunk.frameLength) * 4)
  proc.frameLength += chunk.frameLength
}
engine.stop()
var x = Array(UnsafeBufferPointer(start: proc.floatChannelData![0], count: Int(proc.frameLength)))
// apara o silêncio extra do fim (mantém 120 ms)
var last = x.count - 1
while last > 0 && abs(x[last]) < 0.0008 { last -= 1 }
x = Array(x[0...min(x.count - 1, last + Int(sr * 0.12))])

// ---------- 3) loudness (ITU-R BS.1770, ponderação K + gating) ----------
func biquad(_ s: [Float], _ b: [Double], _ a: [Double]) -> [Float] {
  var y = [Float](repeating: 0, count: s.count); var x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0
  for i in 0..<s.count { let x0 = Double(s[i]); let y0 = b[0]*x0 + b[1]*x1 + b[2]*x2 - a[1]*y1 - a[2]*y2; x2 = x1; x1 = x0; y2 = y1; y1 = y0; y[i] = Float(y0) }
  return y
}
func kCoeffs(_ fs: Double) -> ([Double], [Double], [Double], [Double]) {
  // estágio 1: shelving alto (+4 dB ~1,5 kHz) · estágio 2: passa-alta (RLB)
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196
  let K = tan(Double.pi * f0 / fs), Vh = pow(10, G / 20), Vb = pow(Vh, 0.4996667741545416)
  let a0 = 1 + K / Q + K * K
  let b1 = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0]
  let a1 = [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0]
  let f1 = 38.13547087602444, Q1 = 0.5003270373238773, K1 = tan(Double.pi * f1 / fs)
  let a02 = 1 + K1 / Q1 + K1 * K1
  let b2 = [1.0, -2.0, 1.0], a2 = [1, 2 * (K1 * K1 - 1) / a02, (1 - K1 / Q1 + K1 * K1) / a02]
  return (b1, a1, b2, a2)
}
func lufs(_ s: [Float]) -> Double {
  let (b1, a1, b2, a2) = kCoeffs(sr)
  let k = biquad(biquad(s, b1, a1), b2, a2)
  let blk = Int(sr * 0.4), hop = Int(sr * 0.1)
  var ms: [Double] = []
  var i = 0
  while i + blk <= k.count { var e = 0.0; for j in i..<(i + blk) { e += Double(k[j] * k[j]) }; ms.append(e / Double(blk)); i += hop }
  if ms.isEmpty { var e = 0.0; for v in k { e += Double(v * v) }; ms = [e / Double(max(1, k.count))] }
  let L = { (m: Double) in -0.691 + 10 * log10(max(m, 1e-12)) }
  let abs = ms.filter { L($0) > -70 }
  guard !abs.isEmpty else { return -70 }
  let rel = L(abs.reduce(0, +) / Double(abs.count)) - 10
  let gated = abs.filter { L($0) > rel }
  return L((gated.isEmpty ? abs : gated).reduce(0, +) / Double((gated.isEmpty ? abs : gated).count))
}
// gate suave: nas pausas (40 dB abaixo da fala) o ruído restante é abaixado até -12 dB, sem cortar a fala
if !onlyDenoise {
  let w = Int(sr * 0.02)
  var lv: [Float] = []; var i = 0
  while i + w <= x.count { var e: Float = 0; for j in i..<(i + w) { e += x[j] * x[j] }; lv.append(sqrtf(e / Float(w))); i += w }
  let sorted = lv.sorted()
  if !sorted.isEmpty {
    let speech = sorted[Int(Float(sorted.count) * 0.9)]
    let thr = speech * powf(10, -50 / 20)
    let atk = Float(exp(-1.0 / (sr * 0.002))), relG = Float(exp(-1.0 / (sr * 0.12)))
    var env: Float = 0, g: Float = 1
    for k in 0..<x.count {
      let a = abs(x[k]); env = a > env ? a + (env - a) * atk : a + (env - a) * relG
      let target: Float = env >= thr ? 1 : max(0.5, powf(env / thr, 0.5))   // até -6 dB nas pausas
      g = target > g ? target + (g - target) * 0.995 : target + (g - target) * 0.9995
      x[k] *= g
    }
  }
}
let rawArr = Array(UnsafeBufferPointer(start: mono.floatChannelData![0], count: Int(mono.frameLength)))
let rawLUFS = lufs(rawArr)
var rawPeak: Float = 0; for v in rawArr { rawPeak = max(rawPeak, abs(v)) }
let before = lufs(x)
let gain = onlyDenoise ? 1 : Float(pow(10, (targetLUFS - before) / 20))
for i in 0..<x.count { x[i] *= gain }

// ---------- 4) limitador de pico (-1 dBFS, com antecipação de 3 ms) ----------
let ceiling: Float = pow(10, -1.0 / 20)
let look = Int(sr * 0.003), rel = Float(exp(-1.0 / (sr * 0.06)))
var env: Float = 1, out = [Float](repeating: 0, count: x.count)
var peaksAhead = [Float](repeating: 0, count: x.count)
// pico máximo nos próximos `look` amostras (janela deslizante simples)
for i in stride(from: x.count - 1, through: 0, by: -1) {
  let a = abs(x[i]); peaksAhead[i] = i + 1 < x.count ? max(a, peaksAhead[i + 1] * (i + look < x.count ? 1 : 1)) : a
  if i + look < x.count { peaksAhead[i] = max(a, x[(i + 1)...min(x.count - 1, i + look)].map { abs($0) }.max() ?? a) }
}
for i in 0..<x.count {
  let need: Float = peaksAhead[i] > ceiling ? ceiling / peaksAhead[i] : 1
  env = need < env ? need : min(1, need * (1 - rel) + env * rel)
  out[i] = x[i] * env
}
var peak: Float = 0; for v in out { peak = max(peak, abs(v)) }
let after = lufs(out)

// ---------- 5) gravação: 48 kHz, 24 bits ----------
let outRate = 48000.0, outCh: AVAudioChannelCount = stereo ? 2 : 1
let srcBuf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(out.count))!
srcBuf.frameLength = AVAudioFrameCount(out.count)
out.withUnsafeBufferPointer { p in memcpy(srcBuf.floatChannelData![0], p.baseAddress!, out.count * 4) }
let dstFmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: outRate, channels: outCh, interleaved: false)!
let conv = AVAudioConverter(from: fmt, to: dstFmt)!
conv.sampleRateConverterQuality = AVAudioQuality.max.rawValue
let cap = AVAudioFrameCount(Double(out.count) * outRate / sr + 1024)
let dst = AVAudioPCMBuffer(pcmFormat: dstFmt, frameCapacity: cap)!
var fed = false
var err: NSError?
conv.convert(to: dst, error: &err) { _, status in
  if fed { status.pointee = .endOfStream; return nil }
  fed = true; status.pointee = .haveData; return srcBuf
}
if stereo { memcpy(dst.floatChannelData![1], dst.floatChannelData![0], Int(dst.frameLength) * 4) }
let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: outRate, AVNumberOfChannelsKey: outCh,
  AVLinearPCMBitDepthKey: 24, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false]
try? FileManager.default.removeItem(at: outURL)
guard let outFile = try? AVAudioFile(forWriting: outURL, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false) else { fail("não consegui gravar \(outURL.path)") }
try! outFile.write(from: dst)
print(String(format: "original %.1f LUFS (pico %.1f dBFS) → masterizado %.1f LUFS (pico %.1f dBFS) · %.2f s · 48 kHz/24 bits%@",
  rawLUFS, 20 * log10(Double(max(rawPeak, 1e-9))), after, 20 * log10(Double(max(peak, 1e-9))), Double(out.count) / sr, stereo ? " · estéreo" : ""))
