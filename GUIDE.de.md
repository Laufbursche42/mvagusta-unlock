# Anleitung

> **Wichtig für Fehler-Reports:** Schalte unten auf der Seite den **Diagnose-Log** ein, *bevor* du dich mit dem Scooter verbindest. Nur dann wird der komplette Verbindungsaufbau mitgeschnitten - und genau diese Zeilen brauchen wir in einem [Ticket](https://github.com/Laufbursche42/Laufbursche42/issues), um ein Problem nachzuvollziehen.

## Was du brauchst
- Ein MV-Agusta-Fahrzeug aus der MV-Ride-App: Motorrad, E-Bike oder Kickscooter.
- Ein Handy oder einen Rechner mit **Chrome**, **Edge** oder auf iOS **Bluefy**. Safari und Firefox können kein Web Bluetooth.

## Verbinden
1. Bluetooth am Gerät einschalten, das Fahrzeug einschalten (wecken).
2. Auf **Verbinden** tippen und das Fahrzeug in der Liste auswählen.
3. Taucht es nicht auf, setze den Haken bei **Alle Geräte zeigen** und verbinde erneut. Der echte Test ist der gefundene Bluetooth-Dienst, nicht der angezeigte Name.
4. Die Seite probiert selbst die drei Profile durch (Motorrad, E-Bike, Kickscooter) und nutzt das erste, das antwortet. Welches Profil erkannt wurde, steht danach als Kachel **Profil** und hinter dem Gerätenamen.

## Live-Werte lesen
Das Fahrzeug sendet laufend seinen Status. Jede Kachel erscheint, sobald ihr Wert angekommen ist. Welche Werte kommen, hängt vom Profil ab: Das E-Bike liefert Akku, Tempo, Unterstützung, Strecke, Reichweite, Licht und Fehlercode; der Kickscooter Unterstützungsstufe, Tempomat, Sperre und Licht. Unter den Kacheln kannst du mit **Alle empfangenen Frames** die Rohdaten pro Kennung mitlesen.

## Geschwindigkeit
In keinem der drei Profile gibt es einen Entdrossel-, Regionen- oder Tempolimit-Befehl. Beim E-Bike und Kickscooter begrenzt nur die App-Anzeige das Tempo, das Motorrad kennt nur die Parameter des CUSTOM-Fahrmodus. Deshalb hat diese Seite bewusst kein Tempofeld.

## Sperre (nur Kickscooter)
Nur der Kickscooter hat eine Sperre. In der Karte **Sperre** sendest du mit **Sperren** den Befehl `+LOCK=1` und mit **Entsperren** `+LOCK=0`. Beachte: Einen gesperrten Roller kannst du nur wieder über Bluetooth entsperren. Ein Echo im Log heißt nur, dass der Roller den Befehl angenommen hat; erst der gemeldete Sperrzustand in den Live-Werten beweist, dass es wirkt.

## Einstellungen
Es erscheinen nur Zeilen, die zum verbundenen Profil passen. Kickscooter: Unterstützung (`+MODE`, Stufen keine/Eco/Normal/Sport), Tempomat (`+CRZE`) und Licht (`+HLGT`). Motorrad: ABS-Modus (Normal/Race) und Quickshift als Parameter des CUSTOM-Fahrmodus. Die Motorrad-Parameter nimmt das Cockpit nur an, wenn der CUSTOM-Fahrmodus aktiv ist; sie sind bestätigungspflichtig.

## Erweiterte Einstellungen (Engine-Ebene)
**Rohes Frame** sendet deine Hex-Bytes unverändert an die aktive Schreib-Charakteristik. **ASCII-Befehl** sendet den eingegebenen Text als UTF-8, etwa einen Kickscooter-Befehl wie `+MODE=?` oder ein Motorrad-Textsegment.

## Shortcuts
Kopiere den Link auf den Startbildschirm, dann ent- oder sperrt ein Tipp den Kickscooter direkt. Auf iOS über Bluefy, und das Fahrzeug muss vorher einmal normal verbunden gewesen sein.

## Wenn etwas nicht geht
- Kein Verbinden? Prüfe, dass der Browser Web Bluetooth kann, Bluetooth an ist und das Fahrzeug wach ist. Mit **Alle Geräte zeigen** erneut versuchen.
- Das E-Bike zeigt keine Schalter? Das ist richtig so: Das E-Bike-Profil ist in der App reine Telemetrie und sendet keine Schreibbefehle.
- Nichts passiert nach einem Befehl? Schau ins Log: steht dort "gesendet" aber kein "bestätigt", hat die Firmware das Frame nicht quittiert.
- **Diagnose: alle Geräte auflisten** im Log-Bereich zeigt alle Bluetooth-Dienste eines Geräts, ohne etwas zu schreiben - hilfreich für Support.

## Mithelfen
Willst du herausfinden, ob und wie Tuning bei deinem Scooter geht? Teste dieses Tool an deinem eigenen Fahrzeug und öffne ein Ticket auf [GitHub](https://github.com/Laufbursche42/Laufbursche42/issues) - mit deinem Modell und was funktioniert hat (oder nicht). So finden wir gemeinsam heraus, was bei welchem Modell möglich ist.
