# OpenWrt package Makefile for `bifrost`. Build with the OpenWrt SDK:
#   ln -s .../bifrost/apps/openwrt-client package/bifrost
#   make package/bifrost/compile
# For a quick SDK-less build of the .ipk, use ./build-ipk.sh instead.

include $(TOPDIR)/rules.mk

PKG_NAME:=bifrost
PKG_VERSION:=0.1.0
PKG_RELEASE:=2
PKG_MAINTAINER:=Bifrost
PKG_LICENSE:=MIT

include $(INCLUDE_DIR)/package.mk

define Package/bifrost
  SECTION:=net
  CATEGORY:=Network
  TITLE:=Bifrost VPN
  URL:=https://github.com/bifrost-vpn
  DEPENDS:=+curl +jq +wireguard-tools +kmod-wireguard
  PKGARCH:=all
endef

define Package/bifrost/description
  Connects a GL.iNet/OpenWrt router to your Bifrost VPN. Fetches its config from
  the master and configures WireGuard, with a built-in config page at
  http://<router>/bifrost/ (no LuCI required) and automatic node failover.
endef

define Build/Compile
endef

define Package/bifrost/conffiles
/etc/config/bifrost
endef

define Package/bifrost/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) ./files/usr/bin/bifrost $(1)/usr/bin/bifrost
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/etc/init.d/bifrost $(1)/etc/init.d/bifrost
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/etc/config/bifrost $(1)/etc/config/bifrost
	$(INSTALL_DIR) $(1)/www/bifrost/cgi-bin
	$(INSTALL_DATA) ./files/www/bifrost/index.html $(1)/www/bifrost/index.html
	$(INSTALL_BIN) ./files/www/bifrost/cgi-bin/bifrost $(1)/www/bifrost/cgi-bin/bifrost
endef

$(eval $(call BuildPackage,bifrost))
