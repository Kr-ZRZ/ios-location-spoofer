# iOS Location Spoofer

通过 HTTPS 解密（MITM）拦截 Apple 定位服务回应，修改 GPS 坐标欺骗 iOS 系统定位。

支持 Shadowrocket / Surge / Loon / Quantumult X / Stash 一键导入。

## 导入链接

| 平台 | 链接 |
|------|------|
| Shadowrocket / Surge | [ios-location-spoofer.sgmodule](https://raw.githubusercontent.com/mekos2772/ios-location-spoofer/main/Shadowrocket/ios-location-spoofer.sgmodule) |
| Loon | [ios-location-spoofer.lnplugin](https://raw.githubusercontent.com/mekos2772/ios-location-spoofer/main/Shadowrocket/ios-location-spoofer.lnplugin) |
| Quantumult X | [ios-location-spoofer.snippet](https://raw.githubusercontent.com/mekos2772/ios-location-spoofer/main/Shadowrocket/ios-location-spoofer.snippet) |
| Stash | [ios-location-spoofer.stoverride](https://raw.githubusercontent.com/mekos2772/ios-location-spoofer/main/Shadowrocket/ios-location-spoofer.stoverride) |

## 使用

1. 代理软件中开启 HTTPS 解密，安装并信任 CA 证书
2. 导入对应平台的模块文件并启用
3. 断开重连 VPN，开关定位服务
4. 打开地图 App 验证

## 文件

```
Shadowrocket/
├── ios-location-spoofer.sgmodule    # Shadowrocket / Surge
├── ios-location-spoofer.lnplugin    # Loon
├── ios-location-spoofer.snippet     # Quantumult X
├── ios-location-spoofer.stoverride  # Stash
├── location-spoofer.js              # 核心脚本
├── location-spoofer-qx.js           # QX 专用
├── location-spoofer-config.json     # 配置样板
└── README.md                        # 详细说明
```

默认坐标 Apple Park（37.3349, -122.00902），需自定义及详细教程见 `Shadowrocket/README.md`。
