/*
 * Role Button Feature
 * สร้าง role button panels ที่ซับซ้อนกว่า verification
 * สำหรับอนาคต: multi-role panels, role menus
 */
const { MessageEmbed, MessageActionRow, MessageButton, MessageSelectMenu } = require('discord.js');
const config = require('../config.json');

const MAX_BUTTONS_PER_ROW = 5;
const MAX_ROWS            = 5;
const MAX_ROLES           = MAX_BUTTONS_PER_ROW * MAX_ROWS; // 25

/**
 * สร้าง role button panel (หลายยศในข้อความเดียว)
 * @param {Object} options
 * @param {Array}  options.roles   - [{roleId, label, emoji, style}]
 * @param {Object} options.embed   - embed options
 * @param {string} options.type    - 'button' | 'select'
 */
function buildRolePanel(options = {}) {
    const {
        roles  = [],
        embed  = {},
        type   = 'button'
    } = options;

    if (!roles.length) throw new Error('ต้องมีอย่างน้อย 1 ยศ');
    if (roles.length > MAX_ROLES) throw new Error(`ไม่เกิน ${MAX_ROLES} ยศ`);

    const embedObj = new MessageEmbed()
        .setColor(embed.color || config.system.themeColors.primary)
        .setTitle(embed.title || 'เลือกยศของคุณ');
    if (embed.description) embedObj.setDescription(embed.description);
    if (embed.footer)      embedObj.setFooter({ text: embed.footer });
    if (embed.image)       embedObj.setImage(embed.image);
    if (embed.thumbnail)   embedObj.setThumbnail(embed.thumbnail);

    let components = [];

    if (type === 'select') {
        // Dropdown menu
        const menu = new MessageSelectMenu()
            .setCustomId('roleselect_menu')
            .setPlaceholder('เลือกยศที่ต้องการ...')
            .setMinValues(0)
            .setMaxValues(Math.min(roles.length, 25))
            .addOptions(roles.slice(0, 25).map(r => ({
                label:       r.label || `ยศ ${r.roleId}`,
                value:       `role_${r.roleId}`,
                emoji:       r.emoji  || '🎭',
                description: r.desc   || null
            })));
        components = [new MessageActionRow().addComponents(menu)];
    } else {
        // Buttons (max 5 per row, max 5 rows)
        const rows = [];
        for (let i = 0; i < roles.length; i += MAX_BUTTONS_PER_ROW) {
            const chunk = roles.slice(i, i + MAX_BUTTONS_PER_ROW);
            const row = new MessageActionRow().addComponents(
                chunk.map(r => new MessageButton()
                    .setCustomId(`rolebtn_${r.roleId}`)
                    .setLabel(r.label || `ยศ`)
                    .setEmoji(r.emoji || '🎭')
                    .setStyle(r.style || 'SECONDARY')
                )
            );
            rows.push(row);
        }
        components = rows;
    }

    return { embeds: [embedObj], components };
}

/**
 * Handle role button / select interaction
 */
async function handleRoleInteraction(interaction) {
    const { member, guild, customId } = interaction;

    // Button: rolebtn_{roleId}
    if (interaction.isButton() && customId.startsWith('rolebtn_')) {
        const roleId = customId.replace('rolebtn_', '');
        return toggleRole(interaction, member, guild, roleId);
    }

    // Select menu: roleselect_menu
    if (interaction.isSelectMenu() && customId === 'roleselect_menu') {
        const selectedRoleIds = interaction.values.map(v => v.replace('role_', ''));
        // ยศทั้งหมดที่มีใน panel นี้
        const allPanelRoleIds = interaction.component.options.map(o => o.value.replace('role_', ''));

        await interaction.deferReply({ ephemeral: true });

        const added   = [];
        const removed = [];

        for (const rid of allPanelRoleIds) {
            const role = guild.roles.cache.get(rid);
            if (!role) continue;
            const has = member.roles.cache.has(rid);
            if (selectedRoleIds.includes(rid) && !has) {
                await member.roles.add(rid).catch(() => {});
                added.push(role.name);
            } else if (!selectedRoleIds.includes(rid) && has) {
                await member.roles.remove(rid).catch(() => {});
                removed.push(role.name);
            }
        }

        const lines = [];
        if (added.length)   lines.push(`✅ เพิ่ม: ${added.join(', ')}`);
        if (removed.length) lines.push(`❌ ลบ: ${removed.join(', ')}`);
        if (!lines.length)  lines.push('ไม่มีการเปลี่ยนแปลง');

        return interaction.editReply({ content: lines.join('\n') });
    }
}

async function toggleRole(interaction, member, guild, roleId) {
    const role = guild.roles.cache.get(roleId);
    if (!role) {
        return interaction.reply({ content: `> ❌ ไม่พบยศนี้`, ephemeral: true });
    }
    try {
        const hasRole = member.roles.cache.has(roleId);
        if (hasRole) {
            await member.roles.remove(roleId);
            const embed = new MessageEmbed()
                .setColor(config.system.themeColors.error)
                .setTitle('Removed Roles')
                .setDescription(`- ${role.toString()} (user)`)
                .setTimestamp();
            return interaction.reply({ embeds: [embed], ephemeral: true });
        } else {
            await member.roles.add(roleId);
            const embed = new MessageEmbed()
                .setColor(config.system.themeColors.success)
                .setTitle('Added Roles')
                .setDescription(`+ ${role.toString()} (user)`)
                .setTimestamp();
            return interaction.reply({ embeds: [embed], ephemeral: true });
        }
    } catch (err) {
        return interaction.reply({ content: `> ❌ จัดการยศไม่ได้: ${err.message}`, ephemeral: true });
    }
}

module.exports = { buildRolePanel, handleRoleInteraction, toggleRole };
