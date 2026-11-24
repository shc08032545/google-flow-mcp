# Google Flow MCP Server (`google-flow-mcp`)

MCP Server ภาษา TypeScript สำหรับเชื่อม AI Agent (Antigravity IDE, Claude Desktop, Cursor ฯลฯ) เข้ากับ **Google Flow Web (`flow.google.com`)** และ **Gemini Omni 1.2 / 1.1 Flash Interactions API** พร้อมตัวตัดภาพ **Storyboard 2×2 Splitter** อัตโนมัติสำหรับงาน Affiliate / หนังสั้น AI

## จุดเด่น (Dual Backend)

| โหมด | Backend | วิธีทำงาน | เหมาะกับใคร |
|---|---|---|---|
| **`cdp`** (ค่าเริ่มต้น) | Google Flow Web (`flow.google.com`) | เกาะแท็บ Chrome ผ่าน CDP (`--remote-debugging-port=9222`) อัปโหลดรูป + ใส่ Prompt + กด Generate | ผู้ใช้ที่มีแพ็กเกจ **Google AI Pro / Ultra** ใช้เครดิต Flow ที่มีอยู่แล้ว |
| **`api`** | Gemini Omni 1.2 / 1.1 Flash | ยิงตรง Official Interactions API (`POST /v1beta/interactions`) + Gemini Files API รองรับคลิป 3–15 วิ และแก้ไข/ต่อคลิปแบบ Multi-turn | งาน Automation เต็มรูปแบบ 100% (ต้องใช้ **Paid Gemini API Tier**) |

---

## เครื่องมือ MCP ทั้งหมด (8 Tools)

1. **`flow_status`** — เช็กสถานะการเชื่อมต่อ Chrome CDP, แท็บ `flow.google.com` ที่เปิดอยู่ และความพร้อมของ `GOOGLE_API_KEY` สำหรับ Omni API
2. **`flow_generate_pack_videos`** ⭐ *(แนะนำสำหรับงาน 3 ซีน)* — ส่ง **Storyboard Sheet ทั้ง 3 ซีน** (`STORYBOARD-SCENE-01/02/03.jpg`) พร้อม Prompt แยกฉากจาก `*_MASTER_PROMPT.md` ไปเจนวิดีโอ **Omni 1.1 Flash (10 วิ/ซีน, 9:16)** และ **ดาวน์โหลด `scene_01.mp4`, `scene_02.mp4`, `scene_03.mp4` กลับมาอัตโนมัติ** รองรับทั้งโหมดส่งทั้งแผ่น (`attachmentMode: "sheet"`) หรือครอป Start+End Frame (`"split_frames"`)
3. **`flow_generate_video`** — สั่งสร้างวิดีโอทีละซีนผ่าน `cdp` หรือ `api` รองรับทั้งส่ง `storyboardSheetPath` ตรงทั้งแผ่น หรือครอป Start+End Frame อัตโนมัติ พร้อม Ingredients สูงสุด 6 รูป
4. **`flow_split_storyboard`** — ตัดภาพ Storyboard Sheet 9:16 แบบ 2×2 ออกเป็น 4 เฟรมสะอาด (`panel_1_start.jpg`, `panel_2.jpg`, `panel_3.jpg`, `panel_4_end.jpg`) พร้อมตัดแถบ Timecode ด้านบนและเส้นขอบกริดออกอัตโนมัติ
5. **`flow_prepare_affiliate_pack`** — เตรียมโฟลเดอร์งานจากสกิล `motion-infographic-affiliate` ครบชุดในคำสั่งเดียว: ตัด `STORYBOARD-SCENE-01/02/03.jpg` เป็น 12 เฟรม, ดึง Prompt แยกฉากจาก `*_MASTER_PROMPT.md` และสร้าง `flow_ready/manifest.json`
6. **`flow_edit_or_extend_video`** — แก้ไขหรือต่อความยาวคลิปจาก `interactionId` เดิม (โหมด `api`, เพิ่มได้ครั้งละ 3–10 วิ สูงสุด 30 วิ)
7. **`flow_screenshot`** — แคปหน้าจอแท็บ `flow.google.com` เพื่อตรวจสถานะการเจนหรือดีบัก UI
8. **`flow_inspect_dom`** — ตรวจ DOM จริงของหน้า `flow.google.com` (textarea, ปุ่ม, file input, video) เพื่อปรับแก้ `selectors.json` หาก Google อัปเดตหน้าเว็บ

---

## รันแบบ Batch 3 ซีน × 10 วิ (Omni 1.1 Flash) จาก Terminal โดยตรง

```bash
# โหมด Google Flow Web (Chrome CDP — ใช้เครดิต Google AI Pro / Ultra)
npm run batch -- --pack ./outputs/adda_5td40m1_20261124 --backend cdp --model gemini-omni-1.1-flash --duration 10 --mode sheet

# โหมด Official Gemini Omni 1.1 Flash API (ต้องเปิด Paid Billing Tier)
npm run batch -- --pack ./outputs/adda_5td40m1_20261124 --backend api --model gemini-omni-1.1-flash --duration 10 --mode sheet
```

ไฟล์วิดีโอที่ดาวน์โหลดกลับมาจะถูกบันทึกไว้ที่ `<packDir>/videos/scene_01.mp4`, `scene_02.mp4`, `scene_03.mp4` พร้อมสรุปใน `batch_result.json`

---

## การติดตั้ง

ต้องมี **Node.js >= 20**

```bash
git clone https://github.com/shc08032545/google-flow-mcp.git
cd google-flow-mcp
npm install
npm run build
```

---

## วิธีตั้งค่าใช้งานกับ MCP Client

### 1. โหมด Google Flow Web (`cdp`) — ใช้เครดิต Google AI Pro / Ultra

**ขั้นที่ 1:** เปิด Chrome ด้วย Remote Debugging (Chrome 136+ บังคับใช้ `--user-data-dir` แยก)

- **Windows (PowerShell):**
  ```powershell
  .\scripts\launch-chrome.ps1
  ```
- **macOS / Linux:**
  ```bash
  chmod +x ./scripts/launch-chrome.sh
  ./scripts/launch-chrome.sh
  ```
- ล็อกอินเข้า [https://flow.google.com/](https://flow.google.com/) และเปิดโปรเจกต์ที่ต้องการค้างไว้

**ขั้นที่ 2:** เพิ่มคอนฟิกลงใน `mcp_config.json` (Antigravity IDE / Claude Desktop / Cursor)

```json
{
  "mcpServers": {
    "google-flow": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/google-flow-mcp/dist/index.js"],
      "env": {
        "FLOW_DEFAULT_BACKEND": "cdp",
        "CHROME_CDP_URL": "http://127.0.0.1:9222",
        "FLOW_URL_MATCH": "flow.google.com",
        "OMNI_DEFAULT_MODEL": "gemini-omni-1.1-flash",
        "FLOW_OUTPUT_DIR": "/ABSOLUTE/PATH/TO/outputs"
      }
    }
  }
}
```

### 2. โหมด Gemini Omni 1.1 / 1.2 Flash API (`api`) — ยิง API ตรง

> ⚠️ **หมายเหตุ:** Gemini Omni 1.1 / 1.2 Flash (`gemini-omni-1.1-flash`, `gemini-omni-1.2-flash`) ใช้งานผ่าน **Paid Gemini API Billing Tier** เท่านั้น (Free Tier มีโควตา 0) และเมื่อส่งทั้ง `firstFramePath` + `lastFramePath` ความยาวคลิปต้องอยู่ระหว่าง **3–10 วินาที**

```json
{
  "mcpServers": {
    "google-flow": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/google-flow-mcp/dist/index.js"],
      "env": {
        "FLOW_DEFAULT_BACKEND": "api",
        "GOOGLE_API_KEY": "AIzaSy...",
        "OMNI_DEFAULT_MODEL": "gemini-omni-1.1-flash",
        "FLOW_OUTPUT_DIR": "/ABSOLUTE/PATH/TO/outputs"
      }
    }
  }
}
```

---

## เวิร์กโฟลว์แนะนำ: Storyboard 2×2 → Google Flow

1. เรียก **`flow_prepare_affiliate_pack`** ชี้ไปที่โฟลเดอร์งานสินค้า (ที่มี `STORYBOARD-SCENE-01/02/03.jpg` และ `*_MASTER_PROMPT.md`)
2. ระบบจะสร้างโฟลเดอร์ `flow_ready/` ที่มี:
   - `scene_01/` .. `scene_03/` (เฟรมสะอาด 4 ภาพต่อฉาก: `panel_1_start.jpg` ถึง `panel_4_end.jpg`)
   - `scene_01_prompt.txt` .. `scene_03_prompt.txt` (Prompt แยกฉากพร้อมใช้)
   - `manifest.json` (แผนผังไฟล์ครบทุกฉาก + Ingredients `PRODUCT-01`, `CHAR-A`, `LOC-01`)
3. เรียก **`flow_generate_video`** ส่งทีละฉากด้วย `firstFramePath` + `lastFramePath` + `referenceImagePaths` + `prompt`
4. หากหน้าเว็บ Google Flow มีการเปลี่ยนปุ่ม/กล่องข้อความ ให้เรียก **`flow_inspect_dom`** แล้วคัดลอก `selectors.example.json` เป็น `selectors.json` เพื่ออัปเดต selector ได้ทันทีโดยไม่ต้องแก้โค้ด

---

## คำสั่งสำหรับพัฒนาและทดสอบ

```bash
npm run typecheck
npm test
npm run build
```
