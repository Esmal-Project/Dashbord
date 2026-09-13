# رله TSETMC — راهنمای نصب روی سرور ایران (۵ دقیقه)

این اسکریپت روی یک سرور با IP ایران اجرا می‌شود و درخواست‌ها را به
`cdn.tsetmc.com` پاس می‌دهد. سایت شما (روی Freebuff یا GitHub Pages) با
تنظیم یک متغیر محیطی به آن وصل می‌شود و داده **زنده لحظه‌ای** می‌گیرد.

## خرید سرور (پیشنهادها)

هر VPS ارزان ایرانی کافی است — وب‌سایت فقط پراکسی چند درخواست JSON است:

- **ابرق Courts / رادون / لیارا / پارس‌پک / آسیاتک** — VPS ارزان ماهانه (~۱۰۰–۳۰۰ هزار تومان)
- مشخصات پیشنهادی: **۱ هسته CPU، ۱GB RAM، پهنای باند نامحدود یا ۱TB** — خیلی بیش از کافی
- سیستم‌عامل: **Ubuntu 22.04 یا 24.04**
- مهم: باید یک **IP معتبر و بدون فیلتر** داشته باشد (اکثراً دارند)

## نصب (کپی-پیست این ۶ دستور)

```bash
# 1) Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2) آپلود فایل relay.js (از همین ریپو) — یا با git:
sudo mkdir -p /opt/tsetmc-relay
sudo curl -fsSL -o /opt/tsetmc-relay/relay.js \
  https://raw.githubusercontent.com/Esmal-Project/Dashbord/main/relay/relay.js

# 3) سرویس systemd
sudo curl -fsSL -o /etc/systemd/system/tsetmc-relay.service \
  https://raw.githubusercontent.com/Esmal-Project/Dashbord/main/relay/tsetmc-relay.service
sudo systemctl daemon-reload
sudo systemctl enable --now tsetmc-relay

# 4) تست
curl "http://127.0.0.1:8787/api/health"
```

اگر در مرحله ۴ جواب `{"ok":true,...}`-مانند گرفتید، رله آماده است.

> **پورت در فایروال:** اگر فایروال دارید (`ufw allow 8787`) و در پنل
> فروشنده VPS هم Security Group مربوطه را باز کنید.

## اتصال سایت به رله

یک متغیر محیطی به سایت اضافه کنید:

```
TSETMC_RELAY=http://<IP-سرور-شما>:8787
```

- روی **Freebuff**: در تنظیمات Environment دیپلوی (یا Settings → Environment سندباکس)
- روی **GitHub Actions** (اختیاری): ریپو → Settings → Secrets and variables → Actions
  → `TSETMC_RELAY` و `RELAY_SECRET`

## امنیت (خیلی توصیه می‌شود)

پورت 8787 عمومی است؛ هرکسی که IP را بداند می‌تواند از رله استفاده کند. برای جلوگیری:

روی سرور:
```bash
sudo sed -i 's/^# Environment=RELAY_SECRET=.*/Environment=RELAY_SECRET=YOUR_TOKEN/' \
  /etc/systemd/system/tsetmc-relay.service
sudo systemctl daemon-reload && sudo systemctl restart tsetmc-relay
```

سپس در Freebuff/GitHub همان مقدار را به‌عنوان `RELAY_SECRET` ست کنید — همه‌ی
فراخوانی‌ها خودکار `?key=YOUR_TOKEN` را اضافه می‌کنند.
