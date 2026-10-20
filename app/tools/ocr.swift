// OCR local com o framework Vision da Apple. Uso: ocr <imagem.png>
// Imprime uma linha de texto reconhecido por linha, de cima para baixo. Nada sai do Mac.
import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count > 1,
      let image = NSImage(contentsOfFile: CommandLine.arguments[1]),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("imagem inválida\n".data(using: .utf8)!)
  exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["pt-BR", "en-US"]
request.usesLanguageCorrection = true

do {
  try VNImageRequestHandler(cgImage: cg).perform([request])
} catch {
  FileHandle.standardError.write("falha no OCR: \(error)\n".data(using: .utf8)!)
  exit(2)
}

let lines = (request.results ?? [])
  .compactMap { obs -> (Double, Double, String)? in
    guard let text = obs.topCandidates(1).first?.string else { return nil }
    return (Double(obs.boundingBox.minY), Double(obs.boundingBox.minX), text)
  }
  .sorted { abs($0.0 - $1.0) > 0.01 ? $0.0 > $1.0 : $0.1 < $1.1 }
for (_, _, text) in lines { print(text) }
