const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

import { 
  WEAPON_ABILITIES, 
  ARMOR_ABILITIES, 
  PERKS_TABLE, 
  QUIRKS_TABLE, 
  FLAWS_TABLE, 
  PRESTIGE_CHALLENGES, 
  CHALLENGE_TABLE 
} from "./crafting-data.js";

// ==================== 辅助本地化函数 ====================
function localizeAbilityName(ab) {
  const key = `PF1DC.Abilities.${ab.id}.Name`;
  const localized = game.i18n.localize(key);
  return localized !== key ? localized : ab.name;
}
function localizeAbilityDesc(ab) {
  const key = `PF1DC.Abilities.${ab.id}.Desc`;
  const localized = game.i18n.localize(key);
  return localized !== key ? localized : ab.desc;
}
function localizeTraitName(type, tr) {
  const key = `PF1DC.Traits.${type}.${tr.id}.Name`;
  const localized = game.i18n.localize(key);
  return localized !== key ? localized : tr.name;
}
function localizeTraitDesc(type, tr) {
  const key = `PF1DC.Traits.${type}.${tr.id}.Desc`;
  const localized = game.i18n.localize(key);
  return localized !== key ? localized : tr.desc;
}

// ==================== 主程序 ====================
export class CraftingApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "pf1-dynamic-crafting-app",
    title: "PF1DC.Title",
    tag: "form",
    position: { width: 650, height: "auto" },
    window: { resizable: true },
    actions: {
      "prepare-vessel": CraftingApp._onPrepareVessel,
      "next-day": CraftingApp._onNextDay,
      "roll-challenge-type": CraftingApp._onRollChallengeType,
      "resolve-challenge": CraftingApp._onResolveChallenge,
      "complete-item": CraftingApp._onCompleteItem,
      "search-specific": CraftingApp._onSearchSpecific,
    },
    form: {
      handler: CraftingApp._onFormChange,
      submitOnChange: true, 
      closeOnSubmit: false,
    },
  };

  static PARTS = {
    form: { template: "modules/pf1-dynamic-crafting/templates/crafting-app.hbs" },
  };

  static weaponCache = [];
  static armorCache = [];
  static shieldCache = [];
  static playerItemsCache = [];

  craftingState = {
    isCrafting: false, isFinalDay: false, currentDay: 1, totalDays: 0,
    currentProgress: 0, targetProgress: 0, craftDC: 0, dailyYield: 0,
    isChallengeDay: false, challengeDays: [], itemCL: 0, currentChallenge: null,
    basePrice: 0, itemName: "", multiplier: 1.0,
    perks: [], quirks: [], flaws: [], flawModifier: 0,
    baseItemId: "", enhancement: 1, abilityName: "", isWeapon: true,
    abilityBonus: 0, abilityPrice: 0, abilityDesc: "",
    itemType: "simple",
    specificItem: null,
    isAdventuring: false,
    isUpgrading: false,
    oldPrice: 0,
    oldItemId: ""
  };

  get _storageKey() {
    return `pf1-dynamic-crafting-state-v24-${game.user.id}`;
  }

  _saveState() { sessionStorage.setItem(this._storageKey, JSON.stringify(this.craftingState)); }
  _loadState() {
    const data = sessionStorage.getItem(this._storageKey);
    if (data) {
      try {
        const parsed = JSON.parse(data);
        if (parsed.isCrafting) this.craftingState = parsed;
      } catch (e) { console.warn("Failed to read crafting state", e); }
    }
  }

  async _prepareContext(options) {
    this._loadState();
    const actors = game.actors.filter(a => a.type === "character" && a.hasPlayerOwner);

    if (CraftingApp.weaponCache.length === 0) {
      const weaponPack = game.packs.get("pf1.weapons-and-ammo");
      if (weaponPack) {
        const index = await weaponPack.getIndex({ fields: ["type", "system"] });
        CraftingApp.weaponCache = index.filter(i => i.type === "weapon" && i.system?.price > 0).map(i => {
          let subtype = "melee";
          if (i.system?.weaponSubtype === "ranged") subtype = "ranged";
          const props = i.system?.properties || {};
          let isThrown = props.thr === true;
          let isFirearm = props.fir === true;
          let isSlashingPiercing = false;
          
          if (Array.isArray(i.system?.damage?.parts) && i.system.damage.parts.length > 0) {
             const part = i.system.damage.parts[0];
             if (Array.isArray(part) && part.length > 1 && Array.isArray(part[1])) {
               const types = part[1];
               if (types.includes("slashing") || types.includes("piercing")) isSlashingPiercing = true;
             }
          }

          let wType = i.system?.subType || "exotic"; 
          if (isFirearm) wType = "exotic"; 

          return { 
            id: i._id, name: i.name, price: i.system.price, subtype, 
            props: { isThrown, isFirearm, isSlashingPiercing },
            wType: wType
          };
        });
      }
    }

    if (CraftingApp.armorCache.length === 0 || CraftingApp.shieldCache.length === 0) {
      const armorPack = game.packs.get("pf1.armors-and-shields");
      if (armorPack) {
        const index = await armorPack.getIndex({ fields: ["type", "system"] });
        const entries = index.filter(i => i.system?.price > 0);
        
        CraftingApp.armorCache = [];
        CraftingApp.shieldCache = [];
        
        entries.forEach(i => {
          let isShield = false;
          if (i.type === "shield" || i.system?.subType === "shield" || i.system?.equipmentSubtype === "shield") {
            isShield = true;
          }
          
          if (isShield) {
            CraftingApp.shieldCache.push({ id: i._id, name: i.name, price: i.system.price, subtype: "shield", aType: "shield" });
          } else {
            let aType = "light"; 
            const eqSub = i.system?.equipmentSubtype;
            const armType = i.system?.armor?.type;
            
            if (eqSub === "heavyArmor" || armType === "heavy") aType = "heavy";
            else if (eqSub === "mediumArmor" || armType === "medium") aType = "medium";
            else if (eqSub === "lightArmor" || armType === "light") aType = "light";

            let isMetal = true;
            let matRaw = i.system?.armor?.material || i.system?.material || "";
            let matStr = "";
            if (typeof matRaw === "string") matStr = matRaw.toLowerCase();
            else if (typeof matRaw === "object" && matRaw !== null) matStr = String(matRaw.base || matRaw.normal || matRaw.custom || "").toLowerCase();
            if (matStr.includes("leather") || matStr.includes("hide") || matStr.includes("cloth") || matStr.includes("wood") || matStr.includes("organic")) isMetal = false;

            CraftingApp.armorCache.push({ id: i._id, name: i.name, price: i.system.price, subtype: "armor", aType: aType, isMetal: isMetal });
          }
        });
      }
    }

    CraftingApp.playerItemsCache = [];
    for (const actor of actors) {
      for (const item of actor.items) {
        if (["weapon", "equipment", "shield"].includes(item.type)) {
           let subtype = item.system.weaponSubtype || item.system.subType || item.system.armor?.type || "simple";
           if (item.type === "weapon") {
              subtype = item.system.weaponSubtype === "ranged" ? "ranged" : "melee";
           } else if (item.type === "equipment") {
              subtype = item.system.armor?.type || "light";
           } else if (item.type === "shield") {
              subtype = "shield";
           }

           let abName = "", abBonus = 0, abPrice = 0;
           const flags = item.flags?.["pf1-dynamic-crafting"];
           if (flags && flags.abilityName) {
               abName = flags.abilityName;
               abBonus = flags.abilityBonus || 0;
               abPrice = flags.abilityPrice || 0;
           }
           // 不再从物品描述里正则提取附魔，以避免误伤中文描述中的 "+1000gp" 等文本！

           // 准确读取物品的实际增强加值
           let actualEnh = 0;
           if (item.type === "weapon") {
               actualEnh = item.system.enh || 0;
           } else if (item.type === "equipment" || item.type === "shield") {
               actualEnh = item.system.armor?.enh || item.system.enh || 0;
           }

           // 准确判断是否已经是精制品
           const isOldMasterwork = item.system.masterwork === true || item.system.armor?.masterwork === true || actualEnh > 0;

           CraftingApp.playerItemsCache.push({
             id: item.id,
             actorId: actor.id,
             name: `${actor.name} - ${item.name}`,
             price: item.system.price || 0,
             type: item.type,
             subtype: subtype,
             enh: actualEnh,
             cl: item.system.cl || 0,
             desc: item.system.description?.value || "",
             slot: item.system.slot || "",
             abName: abName,
             abBonus: abBonus,
             abPrice: abPrice,
             isMasterwork: isOldMasterwork
           });
        }
      }
    }

    if (this.craftingState.isCrafting) {
      this.craftingState.isChallengeDay = this.craftingState.challengeDays.includes(this.craftingState.currentDay);
      this.craftingState.isFinalDay = (this.craftingState.currentDay === this.craftingState.totalDays);
    }

    if (this.craftingState.currentChallenge?.isPrestige) {
      this.craftingState.currentChallenge.prestigeOptions = PRESTIGE_CHALLENGES.map((c, index) => ({
        index, name: c.name, selected: index === this.craftingState.currentChallenge.prestigeIndex
      }));
    }

    const actorList = actors.map(a => {
      const skillsObj = {};
      if (a.system?.skills) for (const [k, v] of Object.entries(a.system.skills)) if (v && typeof v.mod === 'number') skillsObj[k] = v.mod;
      return { id: a.id, name: a.name, skillsJSON: JSON.stringify(skillsObj) };
    });

    return { actors: actorList, craftingState: this.craftingState, playerItems: CraftingApp.playerItemsCache };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    setTimeout(() => { 
      this._refreshBaseItemOptions();
      this._refreshUpgradeOptions(context.playerItems);
      this._toggleTypeFields(); 
      this._refreshAllValues(); 
      this._updateDynamicDC(); 
      if (!this.craftingState.isCrafting) this._refreshAbilityOptions();

      const resultsDiv = this.element.querySelector("#specific-search-results");
      if (resultsDiv) {
        resultsDiv.addEventListener("click", (e) => {
          const itemEl = e.target.closest(".search-result-item");
          if (!itemEl) return;
          const packId = itemEl.dataset.pack;
          const id = itemEl.dataset.id;
          const name = itemEl.dataset.name;
          const price = parseInt(itemEl.dataset.price) || 0;
          const cl = parseInt(itemEl.dataset.cl) || 0;

          this.craftingState.specificItem = { packId, id, name, price, cl };
          
          resultsDiv.style.display = "none";
          const selectedDiv = this.element.querySelector("#specific-selected");
          if (selectedDiv) {
            selectedDiv.style.display = "block";
            this.element.querySelector("#selected-item-name").textContent = name;
            this.element.querySelector("#selected-item-price").textContent = price;
            this.element.querySelector("#selected-item-cl").textContent = cl;
          }

          this._updatePricePreview();
        });
      }
    }, 100);
  }

  _refreshBaseItemOptions() {
    const root = this.element;
    if (!root) return;
    const typeSelect = root.querySelector("#item-type");
    const baseSelect = root.querySelector("#base-item");
    if (!typeSelect || !baseSelect) return;

    const type = typeSelect.value;
    baseSelect.innerHTML = "";

    let list = [];
    if (["simple", "martial", "exotic"].includes(type)) {
      list = CraftingApp.weaponCache.filter(w => w.wType === type);
    } else if (["light", "medium", "heavy"].includes(type)) {
      list = CraftingApp.armorCache.filter(a => a.aType === type);
    } else if (type === "shield") {
      list = CraftingApp.shieldCache;
    }

    if (!list.length) {
      baseSelect.innerHTML = `<option value="">- 无 -</option>`;
      return;
    }

    list.forEach(item => {
      const opt = document.createElement("option");
      opt.value = item.id;
      opt.dataset.price = item.price;
      opt.dataset.name = item.name;
      opt.dataset.subtype = item.subtype;
      opt.dataset.atype = item.aType || "";
      opt.dataset.ismetal = item.isMetal !== undefined ? item.isMetal : true;
      if (item.props) opt.dataset.props = JSON.stringify(item.props);
      opt.textContent = `${item.name} (${item.price} gp)`;
      baseSelect.appendChild(opt);
    });
  }

  _refreshUpgradeOptions(playerItems) {
    const root = this.element;
    if (!root) return;
    const upgradeSelect = root.querySelector("#upgrade-item");
    if (!upgradeSelect) return;

    upgradeSelect.innerHTML = `<option value="">- 选择物品 -</option>`;
    if (!playerItems || !playerItems.length) return;

    playerItems.forEach(item => {
      const opt = document.createElement("option");
      opt.value = item.id;
      opt.dataset.price = item.price;
      opt.dataset.name = item.name;
      opt.dataset.type = item.type;
      opt.dataset.subtype = item.subtype;
      opt.dataset.enh = item.enh;
      opt.dataset.cl = item.cl;
      opt.dataset.desc = item.desc;
      opt.dataset.oldabname = item.abName || "";
      opt.dataset.oldabbonus = item.abBonus || 0;
      opt.dataset.oldabprice = item.abPrice || 0;
      opt.dataset.ismasterwork = item.isMasterwork ? "true" : "false";
      opt.textContent = `${item.name} (总价: ${item.price} gp)`;
      upgradeSelect.appendChild(opt);
    });
  }

  _toggleTypeFields() {
    const root = this.element;
    if (!root) return;
    const type = root.querySelector("#item-type")?.value;
    const isUpgrading = root.querySelector("#is-upgrading")?.checked;
    
    const equipFields = root.querySelector("#equipment-fields");
    const wondrousFields = root.querySelector("#wondrous-fields");
    const baseItemGroup = root.querySelector("#base-item-group");
    const upgradeItemGroup = root.querySelector("#upgrade-item-group");
    const enhancementGroup = root.querySelector("#enhancement-group");
    const abilityGroup = root.querySelector("#ability-group");

    if (!equipFields) return;

    if (type === "wondrous") {
      wondrousFields.style.display = "";
      
      if (isUpgrading) {
        equipFields.style.display = ""; 
        baseItemGroup.style.display = "none";
        upgradeItemGroup.style.display = "";
        if(enhancementGroup) enhancementGroup.style.display = "none";
        if(abilityGroup) abilityGroup.style.display = "none";
      } else {
        equipFields.style.display = "none";
      }
    } else {
      equipFields.style.display = "";
      wondrousFields.style.display = "none";
      baseItemGroup.style.display = isUpgrading ? "none" : "";
      upgradeItemGroup.style.display = isUpgrading ? "" : "none";
      if(enhancementGroup) enhancementGroup.style.display = "";
      if(abilityGroup) abilityGroup.style.display = "";
    }
  }

  _refreshAbilityOptions() {
    const root = this.element;
    if (!root) return;
    const typeSelect = root.querySelector("#item-type");
    const baseSelect = root.querySelector("#base-item");
    const upgradeSelect = root.querySelector("#upgrade-item");
    const abilitySelect = root.querySelector("#special-ability");
    if (!typeSelect || !baseSelect || !abilitySelect) return;

    const itemType = typeSelect.value;
    if (itemType === "wondrous") return;

    const isUpgrading = root.querySelector("#is-upgrading")?.checked;
    
    let selectedOption = null;
    let subtype = "melee", aType = "light", isMetal = true;
    let isThrown = false, isFirearm = false, isSlashingPiercing = false;

    if (isUpgrading && upgradeSelect) {
      selectedOption = upgradeSelect.selectedOptions[0];
      if (!selectedOption || !selectedOption.value) {
        abilitySelect.innerHTML = `<option value="0" data-name="" data-cl="0" data-bonus="0" data-price="0" data-desc="">无</option>`;
        return;
      }
      subtype = selectedOption?.dataset.subtype || "melee";
      
      if (itemType === "shield") aType = "shield";
      else if (["light", "medium", "heavy"].includes(itemType)) aType = itemType;
      
    } else {
      selectedOption = baseSelect.selectedOptions[0];
      if (!selectedOption || !selectedOption.value) {
        abilitySelect.innerHTML = `<option value="0" data-name="" data-cl="0" data-bonus="0" data-price="0" data-desc="">无</option>`;
        return;
      }
      subtype = selectedOption?.dataset.subtype || (itemType.includes("simple") ? "melee" : itemType);
      aType = selectedOption?.dataset.atype || "light";
      isMetal = selectedOption?.dataset.ismetal !== "false";

      try {
        const props = JSON.parse(selectedOption?.dataset.props || "{}");
        isThrown = props.isThrown || false;
        isFirearm = props.isFirearm || false;
        isSlashingPiercing = props.isSlashingPiercing || false;
      } catch (e) {}
    }

    abilitySelect.innerHTML = `<option value="0" data-name="" data-cl="0" data-bonus="0" data-price="0" data-desc="">无</option>`;

    let abilities = [];
    const isWeaponType = ["simple", "martial", "exotic"].includes(itemType);

    if (isWeaponType) {
      abilities = WEAPON_ABILITIES.filter(ab => {
        if (ab.req === "slashing_piercing" && !isSlashingPiercing) return false;
        if (ab.req === "thrown" && !isThrown) return false;
        if (ab.req === "firearm" && !isFirearm) return false;
        if (ab.req === "not_firearm" && isFirearm) return false;
        
        if (ab.type === "melee" && subtype !== "melee") return false;
        if (ab.type === "ranged" && subtype !== "ranged") return false;
        
        return true;
      });
    } else {
      abilities = ARMOR_ABILITIES.filter(ab => {
        if (itemType === "shield") {
          if (ab.type !== "both" && ab.type !== "shield" && ab.type !== "armor") return false;
        } else {
          if (ab.type !== "both" && ab.type !== "armor") return false;
        }
        
        if (ab.req === "light_medium" && aType === "heavy") return false;
        if (ab.req === "light" && aType !== "light" && aType !== "shield") return false;
        if (ab.req === "nonmetal" && isMetal) return false;
        if (ab.req === "leather" && isMetal) return false;
        if (ab.req === "organic" && isMetal) return false;
        
        return true;
      });
    }

    abilities.forEach(ab => {
      const opt = document.createElement("option");
      opt.value = ab.name;
      opt.dataset.name = ab.name;
      opt.dataset.cl = ab.cl;
      opt.dataset.bonus = ab.bonus;
      opt.dataset.price = ab.price || 0;
      opt.dataset.desc = localizeAbilityDesc(ab);
      
      let displayText = `${localizeAbilityName(ab)} (`;
      if (ab.bonus > 0) displayText += `+${ab.bonus}`;
      if (ab.price > 0) {
         if (ab.bonus > 0) displayText += `, `;
         displayText += `+${ab.price}gp`;
      }
      displayText += `, CL ${ab.cl})`;
      
      opt.textContent = displayText;
      abilitySelect.appendChild(opt);
    });
  }

  static async _onSearchSpecific(event, target) {
    const root = this.element;
    const query = root.querySelector("#specific-search-input")?.value.trim().toLowerCase();
    if (!query) return ui.notifications.warn(game.i18n.localize("PF1DC.Notify.EnterName"));

    const results = [];
    for (const pack of game.packs) {
      if (pack.documentName !== "Item") continue;
      const index = await pack.getIndex();
      const matches = index.filter(i => i.name.toLowerCase().includes(query) && i.type !== "weapon" && i.type !== "armor" && i.type !== "shield");
      for (const match of matches) {
        results.push({
          packId: pack.collection,
          id: match._id,
          name: match.name,
          type: match.type,
          img: match.img,
          price: match.system?.price || 0,
          cl: match.system?.cl || 0
        });
      }
    }

    const resultsDiv = root.querySelector("#specific-search-results");
    if (results.length === 0) {
      resultsDiv.innerHTML = `<div style="padding: 8px; color: #666;">${game.i18n.localize("PF1DC.Wondrous.NotFound")}</div>`;
    } else {
      resultsDiv.innerHTML = results.map(r => `
        <div class="search-result-item" data-pack="${r.packId}" data-id="${r.id}" data-name="${r.name}" data-price="${r.price}" data-cl="${r.cl}" style="padding: 6px 8px; border-bottom: 1px solid #eee; cursor: pointer;">
          <strong>${r.name}</strong> <span style="color:#666; font-size:0.9em;">(${r.price} gp | CL ${r.cl})</span>
        </div>
      `).join("");
    }
    resultsDiv.style.display = "block";
  }

  _updateDynamicDC() {
    const root = this.element;
    if (!root) return;
    let currentCL = this.craftingState.isCrafting ? this.craftingState.itemCL : (parseInt(root.querySelector("#item-cl")?.textContent) || 0);
    
    const vesselDesc = root.querySelector("#vessel-dc-text");
    if (vesselDesc) {
      vesselDesc.innerHTML = `
        <strong>检定 DC：</strong> 15 + 物品CL (当前为 <strong>${15 + currentCL}</strong>)<br>
        <strong>大成功：</strong> 两个任务均成功，基础价格75%，每日2000gp。<br>
        <strong>成功：</strong> 单任务成功或一成功一失败(差值<5)，基础价格85%，每日1000gp。<br>
        <strong>失败：</strong> 全部失败或差值>=5，基础价格100%，每日500gp。<br>
        <strong>大失败：</strong> 素体损毁，造物中止。
      `;
    }

    const updateOptions = (selectId) => {
      const sel = root.querySelector(`#${selectId}`);
      if (!sel) return;
      Array.from(sel.options).forEach(opt => {
        const val = opt.value;
        if (val === "none") return;
        let dcString = opt.dataset.dc || "15+CL";
        let finalDC = dcString === "15+CL" ? 15 + currentCL : (dcString === "20+CL" ? 20 + currentCL : parseInt(dcString));
        const baseText = opt.dataset.display || opt.textContent.split(" (DC")[0];
        opt.textContent = `${baseText} (DC ${finalDC})`;
      });
    };
    
    updateOptions("vessel-task-1"); updateOptions("vessel-task-2");
    updateOptions("challenge-task-1"); updateOptions("challenge-task-2");
    updateOptions("final-task-1"); updateOptions("final-task-2");

    const finalDesc = root.querySelector("#final-dc-text");
    if (finalDesc) {
      finalDesc.innerHTML = `
        <strong>检定 DC：</strong> 15 + 物品CL (当前为 <strong>${15 + currentCL}</strong>)<br>
        <strong>大成功：</strong> 两个任务均成功，降低10%物品花费。<br>
        <strong>成功：</strong> 完成物品。<br>
        <strong>失败：</strong> 物品已毁坏。
      `;
    }
  }

  _refreshAllValues() {
    const root = this.element;
    if (!root) return;
    const updateBaseValue = (skillId, actorId, baseId) => {
      const skillEl = root.querySelector(`#${skillId}`);
      const actorEl = root.querySelector(`#${actorId}`);
      const baseEl = root.querySelector(`#${baseId}`);
      if (!skillEl || !actorEl || !baseEl) return;
      
      const skillKey = skillEl.value;
      const type = skillEl.selectedOptions[0]?.dataset.type || "skill";
      const actorUuid = actorEl.value;
      
      if (skillKey === "none" || skillKey === "conditions" || !actorUuid) { baseEl.value = 0; return; }
      
      const actor = game.actors.get(actorUuid);
      if (!actor) { baseEl.value = 0; return; }

      let val = 0;
      if (type === "save") {
        val = actor.system?.attributes?.savingThrows?.[skillKey]?.total ?? 0;
      } else {
        if (actor.system?.skills) {
          val = actor.system.skills[skillKey]?.mod || 0;
          if (val === 0 && skillKey === "sen") val = actor.system.skills["sns"]?.mod || 0;
          if (val === 0 && skillKey === "sns") val = actor.system.skills["sen"]?.mod || 0;
        }
      }
      baseEl.value = val;
    };
    ["vessel", "challenge", "final"].forEach(prefix => {
      updateBaseValue(`${prefix}-task-1`, `${prefix}-actor-1`, `${prefix}-base-1`);
      updateBaseValue(`${prefix}-task-2`, `${prefix}-actor-2`, `${prefix}-base-2`);
    });
  }

  _updatePricePreview() {
    const root = this.element;
    if (!root) return;

    const itemType = root.querySelector("#item-type")?.value;
    const isUpgrading = root.querySelector("#is-upgrading")?.checked;
    
    const upgradeSel = root.querySelector("#upgrade-item");
    const hasUpgradeItem = upgradeSel && upgradeSel.value;
    const hasSearchedWondrous = this.craftingState.specificItem !== null;

    const oldContainer = root.querySelector("#old-price-container");
    const diffContainer = root.querySelector("#diff-price-container");
    const oldPreview = root.querySelector("#old-price-preview");
    const diffPreview = root.querySelector("#diff-price-preview");

    if (!isUpgrading) {
      if (oldContainer) oldContainer.style.display = "none";
      if (diffContainer) diffContainer.style.display = "none";
    } else {
      if (itemType === "wondrous") {
        if (hasUpgradeItem && hasSearchedWondrous) {
          const opt = upgradeSel.selectedOptions[0];
          const oldPrice = parseInt(opt.dataset.price) || 0;
          const newPrice = this.craftingState.specificItem.price;
          const diff = newPrice - oldPrice;

          if (root.querySelector("#item-cl")) root.querySelector("#item-cl").textContent = this.craftingState.specificItem.cl;
          if (root.querySelector("#market-price")) root.querySelector("#market-price").textContent = newPrice.toLocaleString();
          if (oldPreview) oldPreview.textContent = oldPrice.toLocaleString();
          if (diffPreview) {
            diffPreview.textContent = diff.toLocaleString();
            diffPreview.style.color = diff <= 0 ? "red" : "green";
          }
          if (root.querySelector("#total-bonus-preview")) root.querySelector("#total-bonus-preview").textContent = "—";

          if (oldContainer) oldContainer.style.display = "block";
          if (diffContainer) diffContainer.style.display = "block";
        } else if (hasUpgradeItem) {
          const opt = upgradeSel.selectedOptions[0];
          const oldPrice = parseInt(opt.dataset.price) || 0;
          if (root.querySelector("#item-cl")) root.querySelector("#item-cl").textContent = opt.dataset.cl || 0;
          if (root.querySelector("#market-price")) root.querySelector("#market-price").textContent = oldPrice.toLocaleString();
          if (oldPreview) oldPreview.textContent = oldPrice.toLocaleString();
          if (diffPreview) {
            diffPreview.textContent = "0";
            diffPreview.style.color = "black";
          }
          if (root.querySelector("#total-bonus-preview")) root.querySelector("#total-bonus-preview").textContent = "—";

          if (oldContainer) oldContainer.style.display = "block";
          if (diffContainer) diffContainer.style.display = "block";
        } else {
          if (root.querySelector("#item-cl")) root.querySelector("#item-cl").textContent = 0;
          if (root.querySelector("#market-price")) root.querySelector("#market-price").textContent = 0;
          if (oldPreview) oldPreview.textContent = "0";
          if (diffPreview) diffPreview.textContent = "0";
          if (root.querySelector("#total-bonus-preview")) root.querySelector("#total-bonus-preview").textContent = "—";
          
          if (oldContainer) oldContainer.style.display = "none";
          if (diffContainer) diffContainer.style.display = "none";
        }
        return; 
      }

      if (hasUpgradeItem) {
        const opt = upgradeSel.selectedOptions[0];
        const oldPrice = parseInt(opt.dataset.price) || 0;
        const oldEnh = parseInt(opt.dataset.enh) || 0; // 现在读取的是系统真实数据，精制品就是 0
        const oldAbilityBonus = parseInt(opt.dataset.oldabbonus) || 0;
        const oldAbilityPrice = parseInt(opt.dataset.oldabprice) || 0;
        const isOldMasterwork = opt.dataset.ismasterwork === "true";

        const enh = parseInt(root.querySelector("#enhancement")?.value) || 0;
        const abilitySelect = root.querySelector("#special-ability");
        const selectedOpt = abilitySelect?.selectedOptions[0];
        
        let abilityBonus = parseInt(selectedOpt?.dataset.bonus) || 0;
        let abilityPrice = parseInt(selectedOpt?.dataset.price) || 0;
        let abilityCL = parseInt(selectedOpt?.dataset.cl) || 0;
        let newAbilityName = selectedOpt?.dataset.name || "";

        let finalAbilityBonus = abilityBonus;
        let finalAbilityPrice = abilityPrice;
        
        const oldAbilityName = opt.dataset.oldabname || "";
        if (oldAbilityName && oldAbilityName !== newAbilityName) {
           finalAbilityBonus += oldAbilityBonus;
           finalAbilityPrice += oldAbilityPrice;
        }

        const totalBonus = enh + finalAbilityBonus;
        const oldTotalBonus = oldEnh + oldAbilityBonus;
        const itemCL = Math.max(enh * 3, abilityCL);
        const isWeaponType = ["simple", "martial", "exotic"].includes(itemType);

        // 计算差价
        const newMagicPrice = isWeaponType ? (totalBonus * totalBonus * 2000) : (totalBonus * totalBonus * 1000) + finalAbilityPrice;
        const oldMagicPrice = isWeaponType ? (oldTotalBonus * oldTotalBonus * 2000) : (oldTotalBonus * oldTotalBonus * 1000) + oldAbilityPrice;
        const magicPriceDiff = newMagicPrice - oldMagicPrice;

        const addMasterworkPrice = isOldMasterwork ? 0 : (isWeaponType ? 300 : 150);

        const newTotalPrice = oldPrice + magicPriceDiff + addMasterworkPrice;
        const diff = newTotalPrice - oldPrice;

        if (root.querySelector("#item-cl")) root.querySelector("#item-cl").textContent = itemCL;
        if (root.querySelector("#market-price")) root.querySelector("#market-price").textContent = newTotalPrice.toLocaleString();
        if (oldPreview) oldPreview.textContent = oldPrice.toLocaleString();
        if (diffPreview) {
          diffPreview.textContent = diff.toLocaleString();
          diffPreview.style.color = diff <= 0 ? "red" : "green";
        }
        if (root.querySelector("#total-bonus-preview")) {
          root.querySelector("#total-bonus-preview").textContent = `+${totalBonus}` + (finalAbilityPrice > 0 ? ` (+${finalAbilityPrice}gp)` : "");
        }

        if (oldContainer) oldContainer.style.display = "block";
        if (diffContainer) diffContainer.style.display = "block";
        return;
      } else {
        if (root.querySelector("#item-cl")) root.querySelector("#item-cl").textContent = 0;
        if (root.querySelector("#market-price")) root.querySelector("#market-price").textContent = 0;
        if (oldPreview) oldPreview.textContent = "0";
        if (diffPreview) diffPreview.textContent = "0";
        if (root.querySelector("#total-bonus-preview")) root.querySelector("#total-bonus-preview").textContent = "+0";

        if (oldContainer) oldContainer.style.display = "none";
        if (diffContainer) diffContainer.style.display = "none";
        return;
      }
    }

    if (itemType === "wondrous") {
      if (hasSearchedWondrous) {
        const price = this.craftingState.specificItem.price;
        if (root.querySelector("#item-cl")) root.querySelector("#item-cl").textContent = this.craftingState.specificItem.cl;
        if (root.querySelector("#market-price")) root.querySelector("#market-price").textContent = price.toLocaleString();
        if (root.querySelector("#total-bonus-preview")) root.querySelector("#total-bonus-preview").textContent = "—";
      }
    } else {
      const baseSelect = root.querySelector("#base-item");
      const basePrice = parseInt(baseSelect?.selectedOptions[0]?.dataset.price) || 0;
      
      const enh = parseInt(root.querySelector("#enhancement")?.value) || 0;
      const abilitySelect = root.querySelector("#special-ability");
      const selectedOpt = abilitySelect?.selectedOptions[0];
      
      let abilityBonus = parseInt(selectedOpt?.dataset.bonus) || 0;
      let abilityPrice = parseInt(selectedOpt?.dataset.price) || 0;
      let abilityCL = parseInt(selectedOpt?.dataset.cl) || 0;

      const totalBonus = enh + abilityBonus;
      const itemCL = Math.max(enh * 3, abilityCL);
      
      let magicPrice, masterworkPrice;
      const isWeaponType = ["simple", "martial", "exotic"].includes(itemType);
      
      if (isWeaponType) {
        magicPrice = totalBonus * totalBonus * 2000;
        masterworkPrice = 300; 
      } else {
        magicPrice = (totalBonus * totalBonus * 1000) + abilityPrice;
        masterworkPrice = (basePrice > 0) ? 150 : 0; 
      }
      
      const newTotalPrice = basePrice + masterworkPrice + magicPrice;
      
      if (root.querySelector("#item-cl")) root.querySelector("#item-cl").textContent = itemCL;
      if (root.querySelector("#market-price")) root.querySelector("#market-price").textContent = newTotalPrice.toLocaleString();
      if (root.querySelector("#total-bonus-preview")) {
        root.querySelector("#total-bonus-preview").textContent = `+${totalBonus}` + (abilityPrice > 0 ? ` (+${abilityPrice}gp)` : "");
      }
    }
  }

  static async _onFormChange(event, form, formData) {
    setTimeout(() => {
      const root = this.element;
      if (!root) return;
      const targetId = event.target.id;

      if (targetId === "is-upgrading") {
        this._toggleTypeFields(); 
        this._refreshAbilityOptions();
      }

      if (targetId === "item-type") {
        this._toggleTypeFields(); 
        this._refreshBaseItemOptions();
        this._refreshAbilityOptions();
      }
      
      if (targetId === "upgrade-item") {
        const opt = event.target.selectedOptions[0];
        if (opt && opt.value) {
          const oldEnh = parseInt(opt.dataset.enh) || 0;
          const oldAbilityName = opt.dataset.oldabname || "";
          
          root.querySelector("#enhancement").value = oldEnh;
          
          if (oldAbilityName) {
            this._refreshAbilityOptions(); 
            const abilitySelect = root.querySelector("#special-ability");
            for (let i = 0; i < abilitySelect.options.length; i++) {
              if (abilitySelect.options[i].dataset.name === oldAbilityName) {
                abilitySelect.selectedIndex = i;
                break;
              }
            }
          }
        }
      } else if (targetId === "base-item") {
        this._refreshAbilityOptions();
      }

      if (targetId === "prestige-select") {
        const idx = parseInt(event.target.value);
        if (idx >= 0) {
          const p = PRESTIGE_CHALLENGES[idx];
          this.craftingState.currentChallenge.task1 = p.task1;
          this.craftingState.currentChallenge.task2 = p.task2;
          this.craftingState.currentChallenge.desc = p.desc;
          this.craftingState.currentChallenge.name = p.name;
          this.craftingState.currentChallenge.results = p.results;
          this.craftingState.currentChallenge.prestigeIndex = idx;
          this._saveState();
          this.render();
          return;
        }
      }

      if (!this.craftingState.isCrafting) {
        this._updatePricePreview();
      }
      this._refreshAllValues();
      this._updateDynamicDC();
    }, 50);
  }

  async _rollCheck(actorId, key, type, tempBonus, dc) {
    const actor = game.actors.get(actorId);
    if (!actor) return { success: false, actor: { name: "未知" }, roll: { dice: [{ results: [{ result: 0 }] }] }, baseMod: 0, total: 0, diff: -999, label: "" };
    
    let baseMod = 0;
    let label = "";
    
    if (type === "save") {
      baseMod = actor.system?.attributes?.savingThrows?.[key]?.total ?? 0;
      label = { fort: "强韧", ref: "反射", will: "意志" }[key] || key;
    } else {
      if (actor.system?.skills) {
        baseMod = actor.system.skills[key]?.mod || 0;
        if (baseMod === 0 && key === "sen") baseMod = actor.system.skills["sns"]?.mod || 0;
        if (baseMod === 0 && key === "sns") baseMod = actor.system.skills["sen"]?.mod || 0;
      }
      label = "技能";
    }
    
    const totalBonus = baseMod + tempBonus;
    const roll = await new Roll(`1d20 + ${totalBonus}`).evaluate();
    return { roll, total: roll.total, success: roll.total >= dc, actor, baseMod, label, diff: roll.total - dc };
  }

  _processTraits(htmlText) {
    const processTable = (keyword, typeStr, rollFunc) => {
      const regex = new RegExp(`(\\d+)\\s*(?:个)?\\s*${keyword}`, 'g');
      let match;
      while ((match = regex.exec(htmlText)) !== null) {
        let count = parseInt(match[1]);
        for (let i = 0; i < count; i++) {
          let result = rollFunc.call(this);
          let content = `<div style="border:1px solid #ccc; padding:8px; margin-top:8px; background:#fff;">
            <strong>🎲 获得${result.type}！</strong><br>
            <strong>掷骰：</strong> d100 = ${result.roll}<br>
            <strong>结果：</strong> ${result.name}<br>
            <em>${result.desc}</em>
          </div>`;
          ChatMessage.create({ content });
        }
      }
    };
    processTable("优点", "优点", this._rollPerk);
    processTable("异常", "异常", this._rollQuirk);
    processTable("瑕疵", "瑕疵", this._rollFlaw);
  }

  _rollPerk() {
    let roll = Math.floor(Math.random() * 100) + 1;
    let res = PERKS_TABLE.find(r => roll >= r.min && roll <= r.max);
    this.craftingState.perks.push(res);
    return { roll, res, type: "Perk", name: localizeTraitName("Perk", res), desc: localizeTraitDesc("Perk", res) };
  }

  _rollQuirk() {
    let roll = Math.floor(Math.random() * 100) + 1;
    let res = QUIRKS_TABLE.find(r => roll >= r.min && roll <= r.max);
    if (res.desc === "ROLL_FLAW") {
        const flaw = this._rollFlaw();
        return { roll, res, type: "异常", name: "异常转瑕疵", desc: `获得瑕疵：${flaw.name}` };
    }
    if (res.desc === "ROLL_PERK") {
        const perk = this._rollPerk();
        return { roll, res, type: "异常", name: "异常转优点", desc: `获得优点：${perk.name}` };
    }
    this.craftingState.quirks.push(res);
    return { roll, res, type: "Quirk", name: localizeTraitName("Quirk", res), desc: localizeTraitDesc("Quirk", res) };
  }

  _rollFlaw() {
    let roll = Math.floor(Math.random() * 100) + 1 + this.craftingState.flawModifier;
    let res = FLAWS_TABLE.find(r => roll >= r.min && roll <= r.max);
    if (res.id === "cursed") this.craftingState.flawModifier = 0;
    else this.craftingState.flawModifier += 5;
    this.craftingState.flaws.push(res);
    return { roll, res, type: "Flaw", name: localizeTraitName("Flaw", res), desc: localizeTraitDesc("Flaw", res) };
  }

  static async _onPrepareVessel(event, target) {
    const root = this.element;
    const itemType = root.querySelector("#item-type").value;
    const isWondrous = itemType === "wondrous";
    const isWeaponType = ["simple", "martial", "exotic"].includes(itemType);
    const isAdventuring = root.querySelector("#is-adventuring")?.checked || false;
    const isUpgrading = root.querySelector("#is-upgrading")?.checked || false;

    let itemCL, marketPrice, itemName, baseItemId, enh, abilityName, abilityBonus = 0, abilityPrice = 0, abilityDesc = "";
    let specificItem = null;
    let oldPrice = 0;

    const upgradeSel = root.querySelector("#upgrade-item");
    const hasUpgradeItem = isUpgrading && upgradeSel?.value;
    const hasSearchedWondrous = this.craftingState.specificItem !== null;
    const isActualUpgrade = isUpgrading && hasUpgradeItem;

    if (isWondrous) {
      if (isActualUpgrade) {
        const opt = upgradeSel.selectedOptions[0];
        oldPrice = parseInt(opt.dataset.price) || 0;
        baseItemId = opt.value;

        if (!hasSearchedWondrous) {
           return ui.notifications.error("强化奇物时，请务必在上方搜索并选择一个新的目标奇物！");
        }
        specificItem = this.craftingState.specificItem;
        itemCL = specificItem.cl;
        marketPrice = specificItem.price - oldPrice;
        if (marketPrice <= 0) {
           return ui.notifications.error("新奇物的价格必须大于原物品的价格！");
        }
        itemName = specificItem.name;
        enh = 0;
        abilityName = "";
      } else {
        if (!hasSearchedWondrous) return ui.notifications.error("请先在上方搜索并选择一个奇物！");
        specificItem = this.craftingState.specificItem;
        itemCL = specificItem.cl;
        marketPrice = specificItem.price;
        itemName = specificItem.name;
        baseItemId = specificItem.id;
        enh = 0;
        abilityName = "";
      }
    }

    if (!specificItem) {
      itemCL = parseInt(root.querySelector("#item-cl").textContent);
      let newTotalPrice = parseInt(root.querySelector("#market-price").textContent.replace(/,/g, ""));
      enh = parseInt(root.querySelector("#enhancement").value) || 0;
      
      const selectedOpt = root.querySelector("#special-ability").selectedOptions[0];
      abilityName = selectedOpt?.dataset.name || "";
      abilityBonus = parseInt(selectedOpt?.dataset.bonus) || 0;
      abilityPrice = parseInt(selectedOpt?.dataset.price) || 0;
      abilityDesc = selectedOpt?.dataset.desc || "";

      if (isUpgrading && hasUpgradeItem) {
         const opt = upgradeSel.selectedOptions[0];
         oldPrice = parseInt(opt.dataset.price) || 0;
         baseItemId = opt.value;
         
         const oldDesc = opt.dataset.desc || "";
         let oldAbilityName = opt.dataset.oldabname || "";
         let oldAbilityBonus = parseInt(opt.dataset.oldabbonus) || 0;
         let oldAbilityPrice = parseInt(opt.dataset.oldabprice) || 0;

         let finalAbilityNames = [];
         let finalAbilityBonus = 0;
         let finalAbilityPrice = 0;
         
         if (oldAbilityName) {
            finalAbilityNames.push(oldAbilityName);
            finalAbilityBonus += oldAbilityBonus;
            finalAbilityPrice += oldAbilityPrice;
         }
         
         if (abilityName && abilityName !== oldAbilityName) {
            finalAbilityNames.push(abilityName);
            finalAbilityBonus += abilityBonus;
            finalAbilityPrice += abilityPrice;
         }
         
         abilityName = finalAbilityNames.join(" ");
         abilityBonus = finalAbilityBonus;
         abilityPrice = finalAbilityPrice;
         
         let oldDescPart = "";
         const oldDescMatch = oldDesc.match(/<div style="font-size:0.95em; color:#333; padding:6px; background:#eee; border-left:3px solid #666; margin-top:4px; white-space:pre-wrap;">([\s\S]*?)<\/div>/);
         if (oldDescMatch && oldDescMatch[1]) oldDescPart = oldDescMatch[1];
         
         if (oldDescPart && abilityDesc) {
             abilityDesc = `【原有】\n${oldDescPart}\n\n【新增】\n${abilityDesc}`;
         } else if (oldDescPart) {
             abilityDesc = oldDescPart;
         }

         let baseName = opt.dataset.name.replace(/^\S+?\s-\s/, ""); 
         baseName = baseName.replace(/\+\d+\s*/g, ""); 
         if (oldAbilityName) baseName = baseName.replace(oldAbilityName, "").trim();
         if (abilityName && abilityName !== oldAbilityName) {
             abilityName.split(" ").forEach(n => { if(n) baseName = baseName.replace(n, "").trim(); });
         }
         
         itemName = (enh > 0 ? `+${enh} ` : "") + (abilityName ? `${abilityName} ` : "") + baseName;
         
         marketPrice = newTotalPrice - oldPrice;
         if (marketPrice <= 0) {
            return ui.notifications.error("新物品的总价必须大于原物品的价格！");
         }
      } else {
         const baseItemOption = root.querySelector("#base-item").selectedOptions[0];
         const baseName = baseItemOption?.dataset.name || "";
         baseItemId = baseItemOption?.value || "";
         itemName = (enh > 0 ? `+${enh} ` : "") + (abilityName ? `${abilityName} ` : "") + baseName;
         marketPrice = newTotalPrice;
      }
    }
    
    const dc = 15 + itemCL;

    const t1 = root.querySelector("#vessel-task-1").value;
    const a1 = root.querySelector("#vessel-actor-1").value;
    const b1 = parseInt(root.querySelector("#vessel-temp-1").value) || 0;
    const t2 = root.querySelector("#vessel-task-2").value;
    const a2 = root.querySelector("#vessel-actor-2").value;
    const b2 = parseInt(root.querySelector("#vessel-temp-2").value) || 0;

    if (t1 === "none" && t2 === "none") return ui.notifications.error("你至少需要选择一个任务进行检定！");
    if (t1 !== "none" && t2 !== "none" && a1 === a2) return ui.notifications.error("同一个人不能同时完成两个任务！请指派不同的角色。");

    let results = [], htmlRolls = "";
    if (t1 !== "none") {
      const r1 = await this._rollCheck(a1, t1, "skill", b1, dc); results.push(r1);
      htmlRolls += `<p><strong>任务 1 - 由 ${r1.actor.name} 进行:</strong> 1d20 (${r1.roll.dice[0].results[0].result}) + ${r1.baseMod + b1} = <strong>${r1.total}</strong> (DC ${dc})</p>`;
    }
    if (t2 !== "none") {
      const r2 = await this._rollCheck(a2, t2, "skill", b2, dc); results.push(r2);
      htmlRolls += `<p><strong>任务 2 - 由 ${r2.actor.name} 进行:</strong> 1d20 (${r2.roll.dice[0].results[0].result}) + ${r2.baseMod + b2} = <strong>${r2.total}</strong> (DC ${dc})</p>`;
    }

    let outcome = "", basePricePercent = 1.0, baseYield = 1000, outcomeColor = "#000";
    const successes = results.filter(r => r.success).length;

    if (results.length === 2) {
      if (successes === 2) { outcome = "大成功：两个任务均成功。素体高级而有效。"; basePricePercent = 0.75; baseYield = 2000; outcomeColor = "green"; }
      else if (successes === 1) {
        if (results.find(r => !r.success).diff >= -5) { outcome = "成功：一个成功，一个失败但差值小于5。获得满意的素体。"; basePricePercent = 0.85; outcomeColor = "green"; }
        else { outcome = "失败：一个成功，一个失败且差值大于等于5。获得有瑕疵的素体。"; baseYield = 500; outcomeColor = "red"; }
      } else { outcome = "大失败：全部失败。素体已损毁，造物中止！"; outcomeColor = "darkred"; }
    } else {
      if (results[0].success) { outcome = "成功：单任务完成。获得满意的素体。"; basePricePercent = 0.85; outcomeColor = "green"; }
      else { outcome = "失败：单任务未完成。获得有瑕疵的素体。"; baseYield = 500; outcomeColor = "red"; }
    }

    const yieldPerDay = isAdventuring ? Math.floor(baseYield / 2) : baseYield;

    let content = `<div style="border:2px solid #7a5c2e; border-radius:6px; padding:12px; background:#fdf6e3; color:#000;">
      <h3 style="margin-top:0; color:#7a5c2e; border-bottom:2px solid #7a5c2e; padding-bottom:4px;">⚒️ 准备素体检定</h3>
      <p><strong>目标物品：</strong> ${itemName}</p><hr style="border-top:1px solid #ccc; margin: 8px 0;">
      ${htmlRolls}<hr style="border-top:1px solid #ccc; margin: 8px 0;">
      <p style="color:${outcomeColor}; font-weight:bold; font-size:1.1em;">结果：${outcome}</p>`;

    if (outcome.includes("大失败")) {
      ChatMessage.create({ speaker: ChatMessage.getSpeaker(), content: content + `</div>` }); return;
    }

    const targetProgress = marketPrice; 
    const totalDays = Math.ceil(targetProgress / yieldPerDay);
    const totalChallenges = Math.floor(marketPrice / 5000) + 1; 
    const remainingChallenges = Math.max(0, totalChallenges - 1); 
    const challengeDays = [];
    if (remainingChallenges > 0 && totalDays > 1) {
      const interval = Math.floor(totalDays / (remainingChallenges + 1));
      for (let i = 1; i <= remainingChallenges; i++) challengeDays.push(interval * i);
    }

    content += `<p><strong>造物进度要求：</strong> ${targetProgress.toLocaleString()} gp</p>
        <p><strong>每日造物进度：</strong> ${yieldPerDay} gp ${isAdventuring ? '(Adventuring, halved)' : ''}</p>
        <p><strong>预计耗时：</strong> ${totalDays} 天</p>
        <p><strong>日程挑战数：</strong> ${challengeDays.length > 0 ? `${challengeDays.length} 个（在第 ${challengeDays.join(", ")} 天）` : "无"}</p></div>`;

    ChatMessage.create({ content: content, flavor: game.i18n.localize("PF1DC.Title") });

    this.craftingState = {
      isCrafting: true, isFinalDay: (1 === totalDays), currentDay: 1, totalDays: totalDays,
      currentProgress: 0, targetProgress: targetProgress, craftDC: dc,
      dailyYield: yieldPerDay, challengeDays: challengeDays, isChallengeDay: false,
      itemCL: itemCL, basePrice: marketPrice, itemName: itemName,
      multiplier: basePricePercent,
      perks: [], quirks: [], flaws: [], flawModifier: 0,
      baseItemId: baseItemId, enhancement: enh, abilityName: abilityName, isWeapon: isWeaponType,
      abilityBonus: abilityBonus, abilityPrice: abilityPrice, abilityDesc: abilityDesc,
      itemType: itemType, specificItem: specificItem, isAdventuring: isAdventuring,
      isUpgrading: isUpgrading && isActualUpgrade, oldPrice: oldPrice, oldItemId: isActualUpgrade ? baseItemId : ""
    };

    this._saveState();
    this.render();
  }

  static async _onNextDay(event, target) {
    this.craftingState.currentProgress += this.craftingState.dailyYield;
    ChatMessage.create({ content: `✅ **第 ${this.craftingState.currentDay} 天**：造物顺利进行，进度 +${this.craftingState.dailyYield} GP。` });
    this.craftingState.currentDay++;
    if (this.craftingState.currentDay >= this.craftingState.totalDays || this.craftingState.currentProgress >= this.craftingState.targetProgress) {
      this.craftingState.isFinalDay = true;
    }
    this._saveState();
    this.render();
  }

  static async _onRollChallengeType(event, target) {
    const roll = await new Roll("1d100").evaluate();
    let challenge = CHALLENGE_TABLE.find(c => roll.total >= c.min && roll.total <= c.max) || CHALLENGE_TABLE[0];
    challenge = foundry.utils.deepClone(challenge);
    if (challenge.isPrestige) {
      challenge.task1 = { key: "none", name: "Select above", dc: "0" };
      challenge.task2 = { key: "none", name: "Select above", dc: "0" };
      challenge.prestigeOptions = PRESTIGE_CHALLENGES.map((c, index) => ({ index, name: c.name, selected: false }));
      challenge.prestigeIndex = -1;
      challenge.results = null;
    }
    this.craftingState.currentChallenge = challenge;
    this._saveState();

    let resultHtml = "";
    if (challenge.results) {
        let sHtml = challenge.results.s.task1 ? `任务1: ${challenge.results.s.task1.html} <br> 任务2: ${challenge.results.s.task2.html}` : challenge.results.s.html;
        resultHtml = `<hr style="border-top:1px solid #ccc; margin: 8px 0;">
          <p><strong>大成功：</strong> ${challenge.results.cs.html}</p>
          <p><strong>成功：</strong> ${sHtml}</p>
          <p><strong>失败：</strong> ${challenge.results.f.html}</p>
          <p><strong>大失败：</strong> ${challenge.results.cf.html}</p>`;
    }

    ChatMessage.create({
      content: `<div style="border:2px solid #d35400; padding:12px; background:#fdebd0; color:#000;">
        <h3 style="margin-top:0; color:#d35400;">⚠️ 触发挑战</h3>
        <p><strong>D100 掷骰：</strong> ${roll.total}</p>
        <p><strong>挑战类型：</strong> ${challenge.name}</p>
        <p><strong>描述：</strong> ${challenge.desc}</p>
        ${resultHtml}
      </div>`
    });
    this.render();
  }

  static async _onResolveChallenge(event, target) {
    const root = this.element;
    const challenge = this.craftingState.currentChallenge;
    if (!challenge) return;
    if (challenge.isPrestige && !challenge.results) return ui.notifications.error("请先在界面里选择一项适用的职业专属挑战！");
    if (!challenge.results) return ui.notifications.error("挑战数据异常，请重新掷骰！");

    const t1 = root.querySelector("#challenge-task-1").value;
    const t1type = root.querySelector("#challenge-task-1").selectedOptions[0]?.dataset.type || "skill";
    const a1 = root.querySelector("#challenge-actor-1").value;
    const b1 = parseInt(root.querySelector("#challenge-temp-1").value) || 0;
    const t2 = root.querySelector("#challenge-task-2").value;
    const t2type = root.querySelector("#challenge-task-2").selectedOptions[0]?.dataset.type || "skill";
    const a2 = root.querySelector("#challenge-actor-2").value;
    const b2 = parseInt(root.querySelector("#challenge-temp-2").value) || 0;

    if (t1 === "none" && t2 === "none") return ui.notifications.error("你至少需要选择一个任务！");
    if (t1 !== "none" && t2 !== "none" && a1 === a2) return ui.notifications.error("同一个人不能同时完成两个任务！请指派不同的角色。");

    const itemCL = this.craftingState.itemCL;
    let results = [], htmlRolls = "", taskKeys = []; 

    if (t1 !== "none") {
      let dc1 = challenge.task1.dc === "15+CL" ? 15 + itemCL : (challenge.task1.dc === "20+CL" ? 20 + itemCL : parseInt(challenge.task1.dc));
      const r1 = await this._rollCheck(a1, t1, t1type, b1, dc1); results.push(r1); taskKeys.push({ isTask1: true, key: t1 });
      htmlRolls += `<p><strong>任务 1 - 由 ${r1.actor.name} 进行 (${r1.label}):</strong> 1d20 (${r1.roll.dice[0].results[0].result}) + ${r1.baseMod + b1} = <strong>${r1.total}</strong> (DC ${dc1})</p>`;
    }
    if (t2 !== "none") {
      let dc2 = challenge.task2.dc === "15+CL" ? 15 + itemCL : (challenge.task2.dc === "20+CL" ? 20 + itemCL : parseInt(challenge.task2.dc));
      const r2 = await this._rollCheck(a2, t2, t2type, b2, dc2); results.push(r2); taskKeys.push({ isTask1: false, key: t2 });
      htmlRolls += `<p><strong>任务 2 - 由 ${r2.actor.name} 进行 (${r2.label}):</strong> 1d20 (${r2.roll.dice[0].results[0].result}) + ${r2.baseMod + b2} = <strong>${r2.total}</strong> (DC ${dc2})</p>`;
    }

    let outcome = "", outcomeColor = "green", adjustDays = 0, adjustCostPercent = 0, resultData = null;
    const successes = results.filter(r => r.success).length;

    if (results.length === 2) {
      if (successes === 2) { outcome = "大成功：两个任务均成功！你克服了挑战，获得优势。"; resultData = challenge.results.cs; }
      else if (successes === 1) {
        const successRoll = results.find(r => r.success); const failRoll = results.find(r => !r.success); const successIdx = results.indexOf(successRoll);
        if (failRoll.diff >= -5) {
          outcome = "成功：一个成功，一个失败但差值小于5。你艰难克服了挑战。";
          resultData = challenge.results.s.task1 ? (taskKeys[successIdx].isTask1 ? challenge.results.s.task1 : challenge.results.s.task2) : challenge.results.s;
        } else { outcome = "失败：一个成功，一个失败且差值大于等于5。你遇到麻烦。"; outcomeColor = "red"; resultData = challenge.results.f; }
      } else { outcome = "大失败：全部失败。你遭遇了严重挫折。"; outcomeColor = "darkred"; resultData = challenge.results.cf; }
    } else {
      const isTask1 = taskKeys[0].isTask1;
      if (results[0].success) {
        outcome = "成功：你克服了挑战。";
        resultData = challenge.results.s.task1 ? (isTask1 ? challenge.results.s.task1 : challenge.results.s.task2) : challenge.results.s;
      } else { outcome = "失败：你未能克服挑战。"; outcomeColor = "red"; resultData = challenge.results.f; }
    }

    if (resultData) { adjustDays = resultData.day || 0; adjustCostPercent = resultData.cost || 0; }

    this.craftingState.totalDays = Math.max(this.craftingState.currentDay, this.craftingState.totalDays + adjustDays);
    this.craftingState.multiplier += (adjustCostPercent / 100);

    let content = `<div style="border:2px solid #d35400; border-radius:6px; padding:12px; background:#fdf6e3; color:#000;">
      <h3 style="margin-top:0; color:#d35400; border-bottom:2px solid #d35400; padding-bottom:4px;">⚠️ 挑战结果</h3>
      <hr style="border-top:1px solid #ccc; margin: 8px 0;">${htmlRolls}<hr style="border-top:1px solid #ccc; margin: 8px 0;">
      <p style="color:${outcomeColor}; font-weight:bold; font-size:1.1em;">结果：${outcome}</p>`;
    if (resultData) content += `<p><strong>具体效果：</strong> ${resultData.html}</p>`;
    content += `</div>`;

    ChatMessage.create({ content: content });

    if (resultData && resultData.html) {
        this._processTraits(resultData.html);
    }

    this.craftingState.isChallengeDay = false;
    this.craftingState.currentChallenge = null;
    this.craftingState.currentDay++;
    if (this.craftingState.currentDay >= this.craftingState.totalDays) this.craftingState.isFinalDay = true;
    this._saveState();
    this.render();
  }

  static async _onCompleteItem(event, target) {
    const root = this.element;
    const t1 = root.querySelector("#final-task-1").value;
    const a1 = root.querySelector("#final-actor-1").value;
    const b1 = parseInt(root.querySelector("#final-temp-1").value) || 0;
    const t2 = root.querySelector("#final-task-2").value;
    const a2 = root.querySelector("#final-actor-2").value;
    const b2 = parseInt(root.querySelector("#final-temp-2").value) || 0;

    if (t1 === "none" && t2 === "none") return ui.notifications.error("你至少需要选择一个任务！");
    if (t1 !== "none" && t2 !== "none" && a1 === a2) return ui.notifications.error("同一个人不能同时完成两个任务！请指派不同的角色。");

    const dc = 15 + this.craftingState.itemCL;
    let results = [], htmlRolls = "";

    if (t1 === "conditions") { results.push({ success: true, actor: game.actors.get(a1) }); htmlRolls += `<p><strong>任务 1 - 由 ${game.actors.get(a1)?.name} 进行:</strong> <span style="color:green">自动成功</span></p>`; } 
    else if (t1 !== "none") { const r1 = await this._rollCheck(a1, t1, "skill", b1, dc); results.push(r1); htmlRolls += `<p><strong>任务 1 - 由 ${r1.actor.name} 进行:</strong> 1d20 (${r1.roll.dice[0].results[0].result}) + ${r1.baseMod + b1} = <strong>${r1.total}</strong> (DC ${dc})</p>`; }

    if (t2 === "conditions") { results.push({ success: true, actor: game.actors.get(a2) }); htmlRolls += `<p><strong>任务 2 - 由 ${game.actors.get(a2)?.name} 进行:</strong> <span style="color:green">自动成功</span></p>`; } 
    else if (t2 !== "none") { const r2 = await this._rollCheck(a2, t2, "skill", b2, dc); results.push(r2); htmlRolls += `<p><strong>任务 2 - 由 ${r2.actor.name} 进行:</strong> 1d20 (${r2.roll.dice[0].results[0].result}) + ${r2.baseMod + b2} = <strong>${r2.total}</strong> (DC ${dc})</p>`; }

    let outcome = "", outcomeColor = "green", isSuccess = false;
    let finalMultiplier = this.craftingState.multiplier;
    let originalPrice = this.craftingState.basePrice; 
    const successes = results.filter(r => r.success).length;

    if (results.length === 2) {
      if (successes === 2) { outcome = "大成功：你以大师般的手法完成了物品。降低10%物品花费。"; isSuccess = true; finalMultiplier -= 0.1; }
      else if (successes === 1) { outcome = "成功：你完成了物品。"; isSuccess = true; }
      else { outcome = "失败：物品已毁坏。"; outcomeColor = "red"; }
    } else {
      if (results[0].success) { outcome = "成功：你完成了物品。"; isSuccess = true; }
      else { outcome = "失败：物品已毁坏。"; outcomeColor = "red"; }
    }

    let newTotalPrice = this.craftingState.isUpgrading && this.craftingState.oldPrice > 0
       ? originalPrice + this.craftingState.oldPrice 
       : originalPrice;
       
    let finalCost = Math.floor(newTotalPrice * finalMultiplier);

    let content = `<div style="border:2px solid #2980b9; border-radius:6px; padding:12px; background:#fdf6e3; color:#000;">
      <h3 style="margin-top:0; color:#2980b9; border-bottom:2px solid #2980b9; padding-bottom:4px;">🏁 完成物品检定</h3>
      <p><strong>目标物品：</strong> ${this.craftingState.itemName}</p><hr style="border-top:1px solid #ccc; margin: 8px 0;">
      ${htmlRolls}<hr style="border-top:1px solid #ccc; margin: 8px 0;">
      <p style="color:${outcomeColor}; font-weight:bold; font-size:1.1em;">结果：${outcome}</p>`;

    if (isSuccess) {
        content += `<p><strong>物品总价：</strong> ${newTotalPrice.toLocaleString()} gp</p>
        <p><strong>最终折扣比例：</strong> ${Math.round(finalMultiplier * 100)}%</p>
        <p><strong>最终材料花费：</strong> <span style="color:darkred; font-size:1.2em; font-weight:bold;">${finalCost.toLocaleString()} gp</span></p>`;

        let newName = this.craftingState.itemName;
        if (this.craftingState.perks.length > 0) newName += ` [${localizeTraitName("Perk", this.craftingState.perks[0])}]`;
        if (this.craftingState.flaws.length > 0) newName += ` [${localizeTraitName("Flaw", this.craftingState.flaws[0])}]`;
        
        let itemData = null;
        let isUpgradeSuccess = false;

        try {
          if (this.craftingState.isUpgrading && this.craftingState.oldItemId) {
            let oldItem = null;
            for (let actor of game.actors) {
               oldItem = actor.items.get(this.craftingState.oldItemId);
               if (oldItem) break;
            }
            
            if (oldItem) {
              let updateData = {
                "name": newName,
                "system.price": newTotalPrice,
                "system.cl": this.craftingState.itemCL,
                "system.masterwork": true,
              };
              
              if (this.craftingState.itemType !== "wondrous") {
                const isWeaponType = ["simple", "martial", "exotic"].includes(this.craftingState.itemType);
                if (isWeaponType) {
                  updateData["system.enh"] = this.craftingState.enhancement;
                } else {
                  updateData["system.armor.enh"] = this.craftingState.enhancement;
                  updateData["system.enh"] = this.craftingState.enhancement;
                }
              } else if (this.craftingState.specificItem) {
                const spec = this.craftingState.specificItem;
                const pack = game.packs.get(spec.packId);
                if (pack) {
                  const doc = await pack.getDocument(spec.id);
                  if (doc) {
                    const docData = doc.toObject();
                    updateData["img"] = docData.img;
                  }
                }
              }

              let descHtml = `<p><strong>造物信息：</strong></p><ul>`;
              if (this.craftingState.enhancement > 0) {
                descHtml += `<li><b>增强加值：</b>+${this.craftingState.enhancement}</li>`;
              }
              if (this.craftingState.abilityName) {
                let abDetail = `<b>特殊附魔：</b>${this.craftingState.abilityName}`;
                if (this.craftingState.abilityBonus > 0) abDetail += ` (等效 +${this.craftingState.abilityBonus})`;
                if (this.craftingState.abilityPrice > 0) abDetail += ` (+${this.craftingState.abilityPrice} gp)`;
                if (this.craftingState.abilityDesc) {
                  abDetail += `<br><div style="font-size:0.95em; color:#333; padding:6px; background:#eee; border-left:3px solid #666; margin-top:4px; white-space:pre-wrap;">${this.craftingState.abilityDesc}</div>`;
                }
                descHtml += `<li>${abDetail}</li>`;
              }
              descHtml += `</ul>`;

              descHtml += `<p><strong>造物特质：</strong></p><ul>`;
              if (this.craftingState.perks.length === 0 && this.craftingState.quirks.length === 0 && this.craftingState.flaws.length === 0) descHtml += `<li>无</li>`;
              this.craftingState.perks.forEach(p => descHtml += `<li style="color:green"><b>优点：${localizeTraitName("Perk", p)}</b> - ${localizeTraitDesc("Perk", p)}</li>`);
              this.craftingState.quirks.forEach(q => descHtml += `<li style="color:#b8860b"><b>异常：${localizeTraitName("Quirk", q)}</b> - ${localizeTraitDesc("Quirk", q)}</li>`);
              this.craftingState.flaws.forEach(f => descHtml += `<li style="color:red"><b>瑕疵：${localizeTraitName("Flaw", f)}</b> - ${localizeTraitDesc("Flaw", f)}</li>`);
              descHtml += `</ul>`;
              
              updateData["system.description.value"] = descHtml + (oldItem.system.description?.value || "");

              updateData["flags.pf1-dynamic-crafting"] = {
                  perks: this.craftingState.perks, 
                  quirks: this.craftingState.quirks, 
                  flaws: this.craftingState.flaws,
                  abilityName: this.craftingState.abilityName,
                  abilityBonus: this.craftingState.abilityBonus,
                  abilityPrice: this.craftingState.abilityPrice
              };

              await oldItem.update(updateData);
              isUpgradeSuccess = true;
              content += `<p style="color:blue; font-weight:bold;">✅ 物品已强化：${newName}</p>`;
            }
          }

          if (!isUpgradeSuccess) {
            if (this.craftingState.itemType === "wondrous" && this.craftingState.specificItem) {
              const spec = this.craftingState.specificItem;
              if (spec && spec.packId && spec.id) {
                const pack = game.packs.get(spec.packId);
                if (pack) {
                  const doc = await pack.getDocument(spec.id);
                  if (doc) itemData = doc.toObject();
                }
              }
              if (!itemData) throw new Error("找不到奇物数据");
            } else {
              const isWeaponType = ["simple", "martial", "exotic"].includes(this.craftingState.itemType);
              const packId = isWeaponType ? "pf1.weapons-and-ammo" : "pf1.armors-and-shields";
              const pack = game.packs.get(packId);
              if (pack && this.craftingState.baseItemId) {
                const doc = await pack.getDocument(this.craftingState.baseItemId);
                if (doc) itemData = doc.toObject();
              }
            }
          }
        } catch (e) { console.warn("获取物品数据失败", e); }

        if (!isUpgradeSuccess) {
          if (!itemData) {
              itemData = {
                  name: newName, type: this.craftingState.itemType === "weapon" ? "weapon" : "equipment",
                  img: "icons/weapons/swords/sword-broad-crystal-paired.webp",
                  system: { 
                      description: { value: "" }, price: newTotalPrice, quantity: 1, equipped: true, carried: true, 
                      identified: true, cl: this.craftingState.itemCL, aura: { custom: false, school: "uni" }, 
                      subType: "simple", actions: [] 
                  }
              };
          }

          itemData.name = newName;
          itemData.system.price = newTotalPrice; 
          itemData.system.cl = this.craftingState.itemCL;
          
          if (this.craftingState.itemType !== "wondrous") {
            const isWeaponType = ["simple", "martial", "exotic"].includes(this.craftingState.itemType);
            if (isWeaponType) {
              itemData.system.enh = this.craftingState.enhancement;
            } else {
              if (!itemData.system.armor) itemData.system.armor = {};
              itemData.system.armor.enh = this.craftingState.enhancement;
              itemData.system.enh = this.craftingState.enhancement;
            }
            itemData.system.masterwork = true;
          }

          let auraSchool = "uni"; 
          if (this.craftingState.abilityDesc) {
            const match = this.craftingState.abilityDesc.match(/灵光：.*?((?:防护|咒法|预言|附魔|塑能|幻术|死灵|变化|通用)系)/);
            if (match && match[1]) {
              const schoolMap = {
                "防护系": "abj", "咒法系": "con", "预言系": "div", "附魔系": "enc",
                "塑能系": "evo", "幻术系": "ill", "死灵系": "nec", "变化系": "trs", "通用系": "uni"
              };
              if (schoolMap[match[1]]) auraSchool = schoolMap[match[1]];
            }
          }
          if (!itemData.system.aura) itemData.system.aura = {};
          itemData.system.aura.school = auraSchool;
          
          itemData.flags = itemData.flags || {};
          itemData.flags["pf1-dynamic-crafting"] = {
              perks: this.craftingState.perks, 
              quirks: this.craftingState.quirks, 
              flaws: this.craftingState.flaws,
              abilityName: this.craftingState.abilityName,
              abilityBonus: this.craftingState.abilityBonus,
              abilityPrice: this.craftingState.abilityPrice
          };

          let descHtml = `<p><strong>造物信息：</strong></p><ul>`;
          if (this.craftingState.enhancement > 0) {
            descHtml += `<li><b>增强加值：</b>+${this.craftingState.enhancement}</li>`;
          }
          if (this.craftingState.abilityName) {
            let abDetail = `<b>特殊附魔：</b>${this.craftingState.abilityName}`;
            if (this.craftingState.abilityBonus > 0) abDetail += ` (等效 +${this.craftingState.abilityBonus})`;
            if (this.craftingState.abilityPrice > 0) abDetail += ` (+${this.craftingState.abilityPrice} gp)`;
            if (this.craftingState.abilityDesc) {
              abDetail += `<br><div style="font-size:0.95em; color:#333; padding:6px; background:#eee; border-left:3px solid #666; margin-top:4px; white-space:pre-wrap;">${this.craftingState.abilityDesc}</div>`;
            }
            descHtml += `<li>${abDetail}</li>`;
          }
          descHtml += `</ul>`;

          descHtml += `<p><strong>造物特质：</strong></p><ul>`;
          if (this.craftingState.perks.length === 0 && this.craftingState.quirks.length === 0 && this.craftingState.flaws.length === 0) descHtml += `<li>无</li>`;
          this.craftingState.perks.forEach(p => descHtml += `<li style="color:green"><b>优点：${localizeTraitName("Perk", p)}</b> - ${localizeTraitDesc("Perk", p)}</li>`);
          this.craftingState.quirks.forEach(q => descHtml += `<li style="color:#b8860b"><b>异常：${localizeTraitName("Quirk", q)}</b> - ${localizeTraitDesc("Quirk", q)}</li>`);
          this.craftingState.flaws.forEach(f => descHtml += `<li style="color:red"><b>瑕疵：${localizeTraitName("Flaw", f)}</b> - ${localizeTraitDesc("Flaw", f)}</li>`);
          descHtml += `</ul>`;
          
          itemData.system.description.value = descHtml + (itemData.system.description?.value || "");

          await Item.create(itemData);
          content += `<p style="color:blue; font-weight:bold;">✅ 物品已创建：${newName}</p>`;
        }
    }

    content += `</div>`;
    ChatMessage.create({ content: content });

    this.craftingState.isCrafting = false;
    this.craftingState.isFinalDay = false;
    sessionStorage.removeItem(this._storageKey); 
    this.render();
    if (!isSuccess) ui.notifications.error("造物失败，物品已毁坏！");
  }
}
