# INSTALL: dành cho agent trong DeepSeek Harness

Bạn vừa nhận gói này (zip đã giải nén, hoặc còn là file `.zip`). Việc của bạn: cài plugin `david-plugin` vào profile `desktop` của Harness trên máy này, kiểm tra, rồi báo lại người dùng. Không cần hỏi lại từng bước; làm hết các bước dưới đây theo thứ tự.

Plugin thêm một tool tên `david_run`: chạy một việc code qua các vai theo chi phí. Cursor (`cursor-workers`) làm việc, Codex (`codex-head`) lập kế hoạch/research khi đáng quota, DeepSeek (`deepseek-v4.1-flash`) chỉ review diff rủi ro, Laya (local, miễn phí) chỉ quyết một việc: tác vụ tiếng Anh có cần plan không. Nó không quyết review (đã đo: không phân biệt được diff rủi ro), nên review do luật cứng gọi.

## Quy tắc khi cài

- Chỉ được đổi: thư mục `~/.dsh/profiles/desktop/plugins/david-plugin`, **một khối có đánh dấu** cuối `~/.dsh/profiles/desktop/cordis.patch.yml` (script tự sao lưu trước), `~/.dsh/PLUGIN-TEMPLATE.md`.
- Không sửa, không xoá entry nào khác trong `cordis.patch.yml`. Không đọc hay in nội dung `~/.dsh/.credentials.yaml`, không in khoá API.
- Không tự khởi động lại Harness: bạn đang chạy bên trong nó. Nhờ người dùng làm.
- Không tải gì từ mạng. Gói này tự đủ.

## Các bước

1. Nếu bạn chỉ có file `.zip`: giải nén vào một thư mục tạm, ví dụ `unzip -q david-plugin.zip -d /tmp/david-install && cd /tmp/david-install/david-plugin`. Nếu đã giải nén thì `cd` vào thư mục chứa file `install.sh`.

2. Chạy:

   ```bash
   ./install.sh --keepalive
   ```

   `--keepalive` cài một LaunchAgent chạy mỗi phút để giữ Laya luôn bật (người dùng đã yêu cầu). Bỏ cờ này nếu họ đổi ý.

3. Đọc kết quả. Phải thấy cả ba dòng:
   - `plugin copied to …/plugins/david-plugin`
   - `patch entry appended …` (hoặc `already present` nếu cài lại)
   - `OK: the Harness accepts the patch entry`

   Dòng `WARNING: 'id: backup-free' not found` nghĩa là profile chưa khai báo model `backup-free` (tầng backup miễn phí, xem `PLUGIN-TEMPLATE.md` §11.8): báo người dùng, đừng tự thêm combo vào 9Router. Dòng `WARNING: '…' not found` khác nghĩa là profile thiếu một route mà plugin gọi (`router9`, `deepseek-host`, hay một model). Báo người dùng đúng dòng đó; đừng tự thêm provider.
   Nếu có `CHECK FAILED`: dừng, chạy `./uninstall.sh`, báo người dùng nội dung lỗi.

4. Nói người dùng: *"Đã cài xong. Hãy khởi động lại DeepSeek Harness, rồi bảo tôi kiểm tra."*

5. Sau khi họ khởi động lại và nhắn bạn: xem danh sách tool của bạn có `david_run` không.
   - Có: gọi thử một lần cho việc nhỏ trong một thư mục git thử (ví dụ tạo repo tạm, `task: "thêm file hello.txt chứa chữ hi"`, `cwd` là repo đó, `plan: "no"`). Kết quả kỳ vọng: báo cáo `david_run: done`, chỉ một agent Cursor chạy, không có review.
   - Không có: kiểm tra Harness có provider subagent tên `spawn` không (entry `subagent-spawn-in-process`). Plugin chỉ gắn tool khi provider đó xuất hiện. Báo người dùng kết quả; đừng sửa cấu hình ngoài khối đã thêm.

6. Cho người dùng biết cách xem plugin đã chạy những ai: mục `Who ran:` ở đầu báo cáo của `david_run`, và lệnh `node ~/.dsh/profiles/desktop/plugins/david-plugin/who.mjs` (xem thêm `~/.dsh/PLUGIN-TEMPLATE.md` §11.7).

7. Báo cáo ngắn cho người dùng: đã cài gì, kết quả bước 3, kết quả bước 5, và nhắc rằng con số ngân sách (Codex 40 lượt/ngày, DeepSeek 300.000 token/ngày) là số giả định, sửa trong `config:` của entry `david-plugin` ở `cordis.patch.yml`.

## Chỉnh cấu hình

Mọi giá trị mặc định nằm ở `plugin/david-plugin/lib/config.js`. Muốn đổi, ghi vào `config:` của entry (chỉ ghi phần đổi), ví dụ:

```yaml
- insert:
    - id: david-plugin
      name: ./plugins/david-plugin/index.js
      config:
        budgets:
          codex: { daily: 20 }
        laya: { reviewThreshold: 0.7 }
```

Rồi khởi động lại Harness.

## Kiểm tra đầu-cuối (tuỳ chọn)

`dev/e2e/run.sh` chạy plugin trong Harness thật với model giả, không dùng khoá, không đụng `~/.dsh`. Cả hai kịch bản phải báo `PASS`.

## Skill `david-force`: bắt buộc dùng david (bật/tắt từng harness)

Cùng gói zip có thêm skill `david-force`; `install.sh` cài luôn (thêm `--no-skill` nếu không muốn), và cài ở trạng thái **TẮT hết**.

```bash
python3 ~/.claude/skills/david-force/scripts/force.py on           # bật cho harness DeepSeek: /david-force on
python3 ~/.claude/skills/david-force/scripts/force.py on codex     # bật thêm cho Codex (cũng: on claude, on all)
python3 ~/.claude/skills/david-force/scripts/force.py off          # tắt hết (off codex: chỉ tắt Codex)
python3 ~/.claude/skills/david-force/scripts/force.py status       # từng harness: bật/tắt, hook, khối quy tắc
```

Mỗi harness có công tắc riêng: `on` chỉ bắt **harness DeepSeek**; Codex và Claude Code **không bị ảnh hưởng** nếu cháu không bật riêng. Khi bật: agent không tự sửa file trong repo git được nữa, các lệnh sửa file bị từ chối kèm cách làm qua david (`david_run`, `david_ask`). Công tắc đọc ở mỗi lần gọi tool nên không cần mở lại app. Codex/Claude gọi plugin bằng CLI `~/.david-force/bin/david run|ask|status`. Đọc file và mọi thứ ngoài repo git (`~/.dsh`, `~/.codex`, `~/.claude`, `~/.agents`, `/tmp`) không bị chặn. Chi tiết và giới hạn: `skill/david-force/SKILL.md`.

## Version

Bản này ghi trong `plugin/david-plugin/package.json` và `CHANGELOG.md`. `install.sh` in `version: <cũ> -> <mới>`; khi báo cáo cho người dùng, nêu số version đã cài. Harness chỉ chạy bản mới sau khi khởi động lại; dòng `Plugin: david-plugin <version>` ở cuối báo cáo `david_run` cho biết bản nào đang chạy thật.

## Gỡ

```bash
./uninstall.sh
```

Xoá plugin, khối trong `cordis.patch.yml` (file về đúng như trước khi cài), skill `david-force` (hook Codex, khối `AGENTS.md`, link; thêm `--keep-skill` để giữ) và LaunchAgent. Sổ chi tiêu `~/.dsh/david-ledger.json` được giữ lại.

## Viết plugin khác, hoặc dựng lại hệ thống

Mở `~/.dsh/PLUGIN-TEMPLATE.md` (script đã chép vào đó). §11 nói nên đặt provider, biến khoá, combo 9Router, thứ tự ưu tiên và Laya thế nào; §4 là khung plugin.

## Cursor: lưu ý (từ bản 0.6.0)

Cursor qua 9Router có thể trả lời "rỗng" (thật ra là lỗi đăng nhập nằm trong luồng HTTP 200). Từ 0.6.0 một route trả về không có chữ nào được tính là **hỏng**: lượt gọi rơi xuống route kế trên chuỗi và route đó nghỉ `routeCooldownMs` (10 phút).

- Muốn tắt hẳn Cursor khỏi worker, sửa khối `config:` của plugin trong `cordis.patch.yml` (đừng sửa gì khác):

  ```yaml
  config:
    chains:
      worker: [backup]
      planner: [codex, backup]
      researcher: [codex, backup]
  ```

- Muốn dùng app Cursor làm worker (không có API): `worker: [cursorqueue, backup]`, rồi nói với app Cursor: *"Xử lý hàng đợi david trong `~/.dsh/cursor-queue`: đọc README.md và làm theo."* Xem `PLUGIN-TEMPLATE.md` §11.10.
