#!/bin/bash
# Install the Asahi VRR test kernel (7.0.11+) ALONGSIDE the stock Fedora kernel.
# Run as root:  sudo bash /home/tristonarmstrong/kernel-vrr/install-vrr-kernel.sh
set -euo pipefail

SRC=/home/tristonarmstrong/kernel-vrr/linux
cd "$SRC"

REL=$(cat include/config/kernel.release)
echo "Installing kernel release: $REL"

# Modules -> /usr/lib/modules/$REL
make -j"$(nproc)" modules_install INSTALL_MOD_STRIP=1

# DTBs -> /boot/dtb-$REL  (mirrors Fedora layout)
mkdir -p "/boot/dtb-$REL"
make dtbs_install "INSTALL_DTBS_PATH=/boot/dtb-$REL"

# Kernel image -> /boot (GRUB loads the raw EFI-stub Image)
cp -f arch/arm64/boot/Image "/boot/vmlinuz-$REL"
cp -f System.map "/boot/System.map-$REL"
cp -f .config "/boot/config-$REL"

# Initramfs
dracut --kver "$REL" --force

# GRUB entry (BLS), keeping the stock kernel as the default
grubby --copy-default \
       --add-kernel="/boot/vmlinuz-$REL" \
       --initrd="/boot/initramfs-$REL.img" \
       --title="Asahi VRR $REL"

echo "OK. Installed:"
ls -la "/boot/vmlinuz-$REL" "/boot/initramfs-$REL.img"
echo "Boot entries:"
grubby --info=ALL | grep -E '^index|kernel='
echo
echo "Default kernel is UNCHANGED (still the stock one)."
echo "To test VRR: reboot, pick the 'Asahi VRR 7.0.11+' entry in GRUB,"
echo "press 'e', append 'appledrm.force_vrr=1' to the linux line, boot with Ctrl-X."
echo "Then verify: modinfo appledrm | grep force_vrr"