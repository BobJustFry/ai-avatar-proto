# Ассеты от Higgsfield для рига

Важная честная оговорка: Higgsfield отдаёт **готовые картинки и видео**, а не слоёный PSD
с прозрачностью. Поэтому путь такой: генерируем персонажа и элементы на плоском фоне,
затем один раз режем на слои (Photopea/Photoshop, ~20–30 минут) и складываем в
`assets/layers/`. Дальше код уже ничего не требует — слои подхватываются по именам.

## 0. Подключение

```bash
npm i -g @higgsfield/cli
higgsfield auth login
npx skills add higgsfield-ai/skills
```

После этого генерации запрашиваются прямо в Claude Code обычным текстом
(«сгенерируй через higgsfield портрет …»). Кредиты тратятся с аккаунта Higgsfield.

## 1. Персонаж (Soul, консистентный характер)

Ключевое — один и тот же персонаж во всех кадрах. В Higgsfield за это отвечает
Soul Character: создайте персонажа один раз и переиспользуйте его во всех запросах.

Базовый портрет:

```
front-facing portrait of a friendly young presenter, head and shoulders,
perfectly symmetrical, looking straight into camera, neutral expression,
mouth closed, eyes open, flat even studio lighting, no harsh shadows,
plain solid light-gray background, no props, 2D stylized illustration,
clean vector-like shading, square 1:1 composition, centered head
```

Что важно в промпте и почему:
- `front-facing`, `symmetrical`, `looking straight` — риг двигает плоские слои, любой
  исходный разворот головы будет драться с анимацией;
- `flat even lighting` — тени, запечённые в текстуру, ломаются при повороте слоёв;
- `plain solid background` — проще вырезать;
- `2D stylized` — у стилизованного персонажа слоёная анимация выглядит естественно,
  у фотореалистичного сразу видно «бумажную куклу».

Дополнительные кадры тем же Soul Character (для слоёв рта и глаз):

```
same character, mouth wide open showing teeth and tongue, same pose, same lighting
same character, mouth in O shape, same pose, same lighting
same character, wide smile showing teeth, same pose, same lighting
same character, eyes fully closed, same pose, same lighting
```

## 2. Резка на слои

Все слои — PNG **1024×1024**, прозрачный фон, персонаж **в одних и тех же координатах**
на каждом слое (это ключ: слои не двигаются друг относительно друга в исходнике,
их двигает риг). Геометрия по умолчанию — в `js/placeholder.js`, константа `GEO`:
голова в центре (512, 545), глаза на y≈548 при x≈428 и x≈596, рот в (512, 700).

Если ваш персонаж встал иначе — не двигайте картинку, а поправьте `pivot` в
`assets/avatar.json` (для век и рта) и `headPivot`.

Нужные файлы в `assets/layers/`:

| Файл | Что на нём | Откуда берётся |
|---|---|---|
| `hair_back.png` | волосы за головой | базовый портрет |
| `body.png` | плечи и шея | базовый портрет |
| `head.png` | лицо **без глаз и рта** (дырки закрашены кожей) | базовый портрет + штамп |
| `eye_white_l/r.png` | белок глаза | базовый портрет |
| `iris_l/r.png` | радужка со зрачком | базовый портрет |
| `eyelid_l/r.png` | веко, закрывающее глаз целиком | кадр с закрытыми глазами |
| `brow_l/r.png` | бровь | базовый портрет |
| `mouth_closed.png` | закрытый рот | базовый портрет |
| `mouth_smile.png` | улыбка | кадр с улыбкой |
| `mouth_e.png` | приоткрытый рот | кадр с открытым ртом, сжать по вертикали |
| `mouth_aa.png` | широко открытый рот | кадр с открытым ртом |
| `mouth_o.png` | рот буквой «о» | кадр с O-образным ртом |

Когда первые PNG готовы, поставьте в `assets/avatar.json` поле `"assets": true` —
до этого код принципиально не обращается к файлам и рисует заглушки.
Дальше любого отсутствующего файла достаточно просто не класть: на его месте
останется заглушка, всё продолжит работать. Слои можно подменять по одному.

## 3. Фоны

Статичный фон (Soul или Nano Banana Pro, 16:9):

```
empty modern podcast studio interior, soft warm key light from the left,
dark teal acoustic panels, shallow depth of field, no people, no text,
cinematic, 16:9
```

Живой фон — видео-луп 5–10 секунд (Kling / Veo / Seedance):

```
slow subtle camera drift inside an empty modern studio, dust motes in the light beam,
no people, no text, seamless loop, 16:9
```

Кладите в `assets/scenes/` и пропишите в `assets/scenes.json`. Для видео важно, чтобы
луп был бесшовным — иначе на стыке будет заметен рывок.

## 4. Что Higgsfield здесь не делает

- Не анимирует персонажа в реальном времени — вся интерактивность локальная.
- Не отдаёт прозрачность: фон режется вручную или инструментом удаления фона.
- Speak v2 / Lip-Sync Studio — отдельный сценарий (готовое говорящее видео по скрипту),
  он не подключается к этому ригу; это другой режим продукта.
