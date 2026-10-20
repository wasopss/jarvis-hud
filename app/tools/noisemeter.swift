// Mede o ruído de fundo de um áudio: piso de ruído (trechos mais silenciosos) e relação sinal/ruído.
// Uso: noisemeter <arquivo> [arquivo ...]
import AVFoundation
import Foundation

for path in CommandLine.arguments.dropFirst() {
  guard let f = try? AVAudioFile(forReading: URL(fileURLWithPath: path)),
        let b = AVAudioPCMBuffer(pcmFormat: f.processingFormat, frameCapacity: AVAudioFrameCount(f.length)) else { print("\(path): não consegui ler"); continue }
  try? f.read(into: b)
  let n = Int(b.frameLength), sr = f.processingFormat.sampleRate, chs = Int(b.format.channelCount)
  var x = [Float](repeating: 0, count: n)
  for c in 0..<chs { for i in 0..<n { x[i] += b.floatChannelData![c][i] / Float(chs) } }
  let win = Int(sr * 0.02)
  var rms: [Double] = []
  var i = 0
  while i + win <= n { var e = 0.0; for j in i..<(i + win) { e += Double(x[j] * x[j]) }; rms.append(sqrt(e / Double(win))); i += win }
  let db = rms.map { 20 * log10(max($0, 1e-9)) }.sorted()
  guard !db.isEmpty else { continue }
  let floorDB = db[Int(Double(db.count) * 0.10)]   // 10% mais silenciosos = ruído de fundo
  let speechDB = db[Int(Double(db.count) * 0.90)]  // 10% mais altos = fala
  print(String(format: "%@\n  ruído de fundo %.1f dBFS · fala %.1f dBFS · sinal/ruído %.1f dB · %.0f Hz", (path as NSString).lastPathComponent, floorDB, speechDB, speechDB - floorDB, sr))
}
